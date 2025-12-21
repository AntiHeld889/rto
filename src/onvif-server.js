const http = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const { v1: uuidv1 } = require('uuid');
const url = require('url');
const fs = require('fs');
const path = require('path');

const { getIp4FromMac } = require('./net-tools')

Date.prototype.stdTimezoneOffset = function () {
    let jan = new Date(this.getFullYear(), 0, 1);
    let jul = new Date(this.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function () {
    return this.getTimezoneOffset() < this.stdTimezoneOffset();
}

module.exports = class OnvifServer {
    constructor(logger, config) {
        this.config = config;
        this.logger = logger;

        this.config.hostname = getIp4FromMac(logger, this.config.mac);
        if (!this.config.hostname)
            return -1;

        this.videoSource = {
            token: 'video_src_token',
            Framerate: this.config.highQuality.framerate,
            Resolution: { Width: this.config.highQuality.width, Height: this.config.highQuality.height }
        };

        this.profiles = [
            {
                Name: 'MainStream',
                token: 'main_stream',
                VideoSourceConfiguration: {
                    Name: 'VideoSource',
                    UseCount: 2,
                    token: 'video_src_config_token',
                    SourceToken: 'video_src_token',
                    Bounds: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height }
                },
                VideoEncoderConfiguration: {
                    token: 'encoder_hq_config_token',
                    Name: 'CardinalHqCameraConfiguration',
                    UseCount: 1,
                    Encoding: 'H264',
                    Resolution: {
                        Width: this.config.highQuality.width,
                        Height: this.config.highQuality.height
                    },
                    Quality: this.config.highQuality.quality,
                    RateControl: {
                        FrameRateLimit: this.config.highQuality.framerate,
                        EncodingInterval: 1,
                        BitrateLimit: this.config.highQuality.bitrate
                    },
                    H264: {
                        GovLength: this.config.highQuality.framerate,
                        H264Profile: 'Main'
                    },
                    SessionTimeout: 'PT1000S'
                }
            }
        ];

        if (this.config.lowQuality) {
            this.profiles.push({
                Name: 'SubStream',
                token: 'sub_stream',
                VideoSourceConfiguration: {
                    Name: 'VideoSource',
                    UseCount: 2,
                    token: 'video_src_config_token',
                    SourceToken: 'video_src_token',
                    Bounds: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height }
                },
                VideoEncoderConfiguration: {
                    token: 'encoder_lq_config_token',
                    Name: 'CardinalLqCameraConfiguration',
                    UseCount: 1,
                    Encoding: 'H264',
                    Resolution: {
                        Width: this.config.lowQuality.width,
                        Height: this.config.lowQuality.height
                    },
                    Quality: this.config.lowQuality.quality,
                    RateControl: {
                        FrameRateLimit: this.config.lowQuality.framerate,
                        EncodingInterval: 1,
                        BitrateLimit: this.config.lowQuality.bitrate
                    },
                    H264: {
                        GovLength: this.config.lowQuality.framerate,
                        H264Profile: 'Main'
                    },
                    SessionTimeout: 'PT1000S'
                }
            });
        }
    }

    createSoapEnvelope(body) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
    xmlns:tt="http://www.onvif.org/ver10/schema">
    <SOAP-ENV:Body>
        ${body}
    </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    }

    handleDeviceService(soapBody) {
        if (soapBody.includes('GetSystemDateAndTime')) {
            let now = new Date();
            let offset = now.getTimezoneOffset();
            let abs_offset = Math.abs(offset);
            let hrs_offset = Math.floor(abs_offset / 60);
            let mins_offset = (abs_offset % 60);
            let tz = 'UTC' + (offset > 0 ? '-' : '+') + hrs_offset + (mins_offset === 0 ? '' : ':' + mins_offset);

            return this.createSoapEnvelope(`
                <tds:GetSystemDateAndTimeResponse>
                    <tds:SystemDateAndTime>
                        <tt:DateTimeType>NTP</tt:DateTimeType>
                        <tt:DaylightSavings>${now.isDstObserved()}</tt:DaylightSavings>
                        <tt:TimeZone>
                            <tt:TZ>${tz}</tt:TZ>
                        </tt:TimeZone>
                        <tt:UTCDateTime>
                            <tt:Time>
                                <tt:Hour>${now.getUTCHours()}</tt:Hour>
                                <tt:Minute>${now.getUTCMinutes()}</tt:Minute>
                                <tt:Second>${now.getUTCSeconds()}</tt:Second>
                            </tt:Time>
                            <tt:Date>
                                <tt:Year>${now.getUTCFullYear()}</tt:Year>
                                <tt:Month>${now.getUTCMonth() + 1}</tt:Month>
                                <tt:Day>${now.getUTCDate()}</tt:Day>
                            </tt:Date>
                        </tt:UTCDateTime>
                        <tt:LocalDateTime>
                            <tt:Time>
                                <tt:Hour>${now.getHours()}</tt:Hour>
                                <tt:Minute>${now.getMinutes()}</tt:Minute>
                                <tt:Second>${now.getSeconds()}</tt:Second>
                            </tt:Time>
                            <tt:Date>
                                <tt:Year>${now.getFullYear()}</tt:Year>
                                <tt:Month>${now.getMonth() + 1}</tt:Month>
                                <tt:Day>${now.getDate()}</tt:Day>
                            </tt:Date>
                        </tt:LocalDateTime>
                    </tds:SystemDateAndTime>
                </tds:GetSystemDateAndTimeResponse>
            `);
        } else if (soapBody.includes('GetDeviceInformation')) {
            return this.createSoapEnvelope(`
                <tds:GetDeviceInformationResponse>
                    <tds:Manufacturer>rtsp-2-onvif</tds:Manufacturer>
                    <tds:Model>${this.config.name}</tds:Model>
                    <tds:FirmwareVersion>1.0.0</tds:FirmwareVersion>
                    <tds:SerialNumber>${this.config.name.replace(' ', '_')}-0000</tds:SerialNumber>
                    <tds:HardwareId>${this.config.name.replace(' ', '_')}-1001</tds:HardwareId>
                </tds:GetDeviceInformationResponse>
            `);
        } else if (soapBody.includes('GetCapabilities')) {
            return this.createSoapEnvelope(`
                <tds:GetCapabilitiesResponse>
                    <tds:Capabilities>
                        <tt:Device>
                            <tt:XAddr>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</tt:XAddr>
                            <tt:System>
                                <tt:DiscoveryResolve>false</tt:DiscoveryResolve>
                                <tt:DiscoveryBye>false</tt:DiscoveryBye>
                                <tt:RemoteDiscovery>false</tt:RemoteDiscovery>
                                <tt:SystemBackup>false</tt:SystemBackup>
                                <tt:SystemLogging>false</tt:SystemLogging>
                                <tt:FirmwareUpgrade>false</tt:FirmwareUpgrade>
                                <tt:SupportedVersions>
                                    <tt:Major>2</tt:Major>
                                    <tt:Minor>5</tt:Minor>
                                </tt:SupportedVersions>
                            </tt:System>
                        </tt:Device>
                        <tt:Media>
                            <tt:XAddr>http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service</tt:XAddr>
                            <tt:StreamingCapabilities>
                                <tt:RTPMulticast>false</tt:RTPMulticast>
                                <tt:RTP_TCP>true</tt:RTP_TCP>
                                <tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP>
                            </tt:StreamingCapabilities>
                            <tt:SnapshotUri>true</tt:SnapshotUri>
                        </tt:Media>
                    </tds:Capabilities>
                </tds:GetCapabilitiesResponse>
            `);
        } else if (soapBody.includes('GetServices')) {
            // Check if client wants capabilities included
            const includeCapability = soapBody.includes('IncludeCapability>true') ||
                                     soapBody.includes('IncludeCapability="true"');

            const mediaCapabilities = includeCapability ? `
                        <tds:Capabilities>
                            <trt:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
                                <trt:ProfileCapabilities MaximumNumberOfProfiles="2"/>
                                <trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="true" RTP_RTSP_TCP="true"/>
                            </trt:Capabilities>
                        </tds:Capabilities>` : '';

            return this.createSoapEnvelope(`
                <tds:GetServicesResponse>
                    <tds:Service>
                        <tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>
                        <tds:XAddr>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</tds:XAddr>
                        <tds:Version>
                            <tt:Major>2</tt:Major>
                            <tt:Minor>5</tt:Minor>
                        </tds:Version>
                    </tds:Service>
                    <tds:Service>
                        <tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>
                        <tds:XAddr>http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service</tds:XAddr>
                        <tds:Version>
                            <tt:Major>2</tt:Major>
                            <tt:Minor>5</tt:Minor>
                        </tds:Version>${mediaCapabilities}
                    </tds:Service>
                </tds:GetServicesResponse>
            `);
        }

        return null;
    }

    handleMediaService(soapBody) {
        if (soapBody.includes('GetProfiles')) {
            let profilesXml = this.profiles.map(profile => `
                <trt:Profiles token="${profile.token}">
                    <tt:Name>${profile.Name}</tt:Name>
                    <tt:VideoSourceConfiguration token="${profile.VideoSourceConfiguration.token}">
                        <tt:Name>${profile.VideoSourceConfiguration.Name}</tt:Name>
                        <tt:UseCount>${profile.VideoSourceConfiguration.UseCount}</tt:UseCount>
                        <tt:SourceToken>${profile.VideoSourceConfiguration.SourceToken}</tt:SourceToken>
                        <tt:Bounds x="${profile.VideoSourceConfiguration.Bounds.x}" y="${profile.VideoSourceConfiguration.Bounds.y}"
                                   width="${profile.VideoSourceConfiguration.Bounds.width}" height="${profile.VideoSourceConfiguration.Bounds.height}"/>
                    </tt:VideoSourceConfiguration>
                    <tt:VideoEncoderConfiguration token="${profile.VideoEncoderConfiguration.token}">
                        <tt:Name>${profile.VideoEncoderConfiguration.Name}</tt:Name>
                        <tt:UseCount>${profile.VideoEncoderConfiguration.UseCount}</tt:UseCount>
                        <tt:Encoding>${profile.VideoEncoderConfiguration.Encoding}</tt:Encoding>
                        <tt:Resolution>
                            <tt:Width>${profile.VideoEncoderConfiguration.Resolution.Width}</tt:Width>
                            <tt:Height>${profile.VideoEncoderConfiguration.Resolution.Height}</tt:Height>
                        </tt:Resolution>
                        <tt:Quality>${profile.VideoEncoderConfiguration.Quality}</tt:Quality>
                        <tt:RateControl>
                            <tt:FrameRateLimit>${profile.VideoEncoderConfiguration.RateControl.FrameRateLimit}</tt:FrameRateLimit>
                            <tt:EncodingInterval>${profile.VideoEncoderConfiguration.RateControl.EncodingInterval}</tt:EncodingInterval>
                            <tt:BitrateLimit>${profile.VideoEncoderConfiguration.RateControl.BitrateLimit}</tt:BitrateLimit>
                        </tt:RateControl>
                        <tt:H264>
                            <tt:GovLength>${profile.VideoEncoderConfiguration.H264.GovLength}</tt:GovLength>
                            <tt:H264Profile>${profile.VideoEncoderConfiguration.H264.H264Profile}</tt:H264Profile>
                        </tt:H264>
                    </tt:VideoEncoderConfiguration>
                </trt:Profiles>
            `).join('');

            return this.createSoapEnvelope(`
                <trt:GetProfilesResponse>
                    ${profilesXml}
                </trt:GetProfilesResponse>
            `);
        } else if (soapBody.includes('GetVideoSources')) {
            return this.createSoapEnvelope(`
                <trt:GetVideoSourcesResponse>
                    <trt:VideoSources token="${this.videoSource.token}">
                        <tt:Framerate>${this.videoSource.Framerate}</tt:Framerate>
                        <tt:Resolution>
                            <tt:Width>${this.videoSource.Resolution.Width}</tt:Width>
                            <tt:Height>${this.videoSource.Resolution.Height}</tt:Height>
                        </tt:Resolution>
                    </trt:VideoSources>
                </trt:GetVideoSourcesResponse>
            `);
        } else if (soapBody.includes('GetStreamUri')) {
            let profileToken = 'main_stream';
            if (soapBody.includes('sub_stream')) {
                profileToken = 'sub_stream';
            }

            let rtspPath = this.config.highQuality.rtsp;
            if (profileToken === 'sub_stream' && this.config.lowQuality) {
                rtspPath = this.config.lowQuality.rtsp;
            }

            return this.createSoapEnvelope(`
                <trt:GetStreamUriResponse>
                    <trt:MediaUri>
                        <tt:Uri>rtsp://${this.config.hostname}:${this.config.ports.rtsp}${rtspPath}</tt:Uri>
                        <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
                        <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
                        <tt:Timeout>PT30S</tt:Timeout>
                    </trt:MediaUri>
                </trt:GetStreamUriResponse>
            `);
        } else if (soapBody.includes('GetSnapshotUri')) {
            // Use local HTTP proxy endpoint for reliable snapshot delivery
            let uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot`;

            return this.createSoapEnvelope(`
                <trt:GetSnapshotUriResponse>
                    <trt:MediaUri>
                        <tt:Uri>${uri}</tt:Uri>
                        <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
                        <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
                        <tt:Timeout>PT30S</tt:Timeout>
                    </trt:MediaUri>
                </trt:GetSnapshotUriResponse>
            `);
        }

        return null;
    }

    startHttpServer() {
        this.logger.info(`SERVER: ${this.config.name} - HTTP listening on ${this.config.hostname}:${this.config.ports.server}`);

        const self = this;

        this.server = http.createServer((request, response) => {
            const pathname = url.parse(request.url).pathname;

            if (pathname === '/snapshot.png') {
                // Serve static placeholder image
                try {
                    const imagePath = path.join(process.cwd(), 'resources', 'snapshot.png');
                    const image = fs.readFileSync(imagePath);
                    response.writeHead(200, { 'Content-Type': 'image/png' });
                    response.end(image, 'binary');
                } catch (err) {
                    response.writeHead(404, { 'Content-Type': 'text/plain' });
                    response.end('Snapshot not found');
                }
            } else if (pathname === '/snapshot') {
                // Proxy snapshot from target server via HTTP
                // This is more reliable than TCP proxy for large binary data
                const snapshotPath = self.config.highQuality?.snapshot;
                if (!snapshotPath || !self.config.target?.hostname || !self.config.target?.ports?.snapshot) {
                    // Fallback to static placeholder
                    try {
                        const imagePath = path.join(process.cwd(), 'resources', 'snapshot.png');
                        const image = fs.readFileSync(imagePath);
                        response.writeHead(200, { 'Content-Type': 'image/png' });
                        response.end(image, 'binary');
                    } catch (err) {
                        response.writeHead(404, { 'Content-Type': 'text/plain' });
                        response.end('Snapshot not found');
                    }
                    return;
                }

                const targetUrl = `http://${self.config.target.hostname}:${self.config.target.ports.snapshot}${snapshotPath}`;

                http.get(targetUrl, (proxyRes) => {
                    const chunks = [];
                    proxyRes.on('data', chunk => chunks.push(chunk));
                    proxyRes.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        response.writeHead(proxyRes.statusCode, {
                            'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
                            'Content-Length': buffer.length,
                            'Cache-Control': 'no-cache'
                        });
                        response.end(buffer);
                    });
                    proxyRes.on('error', (err) => {
                        response.writeHead(502, { 'Content-Type': 'text/plain' });
                        response.end('Snapshot proxy error');
                    });
                }).on('error', (err) => {
                    response.writeHead(502, { 'Content-Type': 'text/plain' });
                    response.end('Snapshot request error');
                });
            } else if (pathname === '/onvif/device_service') {
                if (request.method === 'GET') {
                    try {
                        const wsdlPath = path.join(process.cwd(), 'wsdl', 'device_service.wsdl');
                        const wsdl = fs.readFileSync(wsdlPath, 'utf8');
                        response.writeHead(200, { 'Content-Type': 'text/xml' });
                        response.end(wsdl);
                    } catch (err) {
                        response.writeHead(500, { 'Content-Type': 'text/plain' });
                        response.end('WSDL not found');
                    }
                } else if (request.method === 'POST') {
                    let body = '';
                    request.on('data', chunk => body += chunk.toString());
                    request.on('end', () => {
                        const soapResponse = self.handleDeviceService(body);
                        if (soapResponse) {
                            response.writeHead(200, {
                                'Content-Type': 'application/soap+xml; charset=utf-8'
                            });
                            response.end(soapResponse);
                        } else {
                            response.writeHead(500, { 'Content-Type': 'text/plain' });
                            response.end('Unknown SOAP action');
                        }
                    });
                }
            } else if (pathname === '/onvif/media_service') {
                if (request.method === 'GET') {
                    try {
                        const wsdlPath = path.join(process.cwd(), 'wsdl', 'media_service.wsdl');
                        const wsdl = fs.readFileSync(wsdlPath, 'utf8');
                        response.writeHead(200, { 'Content-Type': 'text/xml' });
                        response.end(wsdl);
                    } catch (err) {
                        response.writeHead(500, { 'Content-Type': 'text/plain' });
                        response.end('WSDL not found');
                    }
                } else if (request.method === 'POST') {
                    let body = '';
                    request.on('data', chunk => body += chunk.toString());
                    request.on('end', () => {
                        const soapResponse = self.handleMediaService(body);
                        if (soapResponse) {
                            response.writeHead(200, {
                                'Content-Type': 'application/soap+xml; charset=utf-8'
                            });
                            response.end(soapResponse);
                        } else {
                            response.writeHead(500, { 'Content-Type': 'text/plain' });
                            response.end('Unknown SOAP action');
                        }
                    });
                }
            } else {
                response.writeHead(404, { 'Content-Type': 'text/plain' });
                response.end('Not found');
            }
        });

        this.server.listen(this.config.ports.server, this.config.hostname);
    }

    enableDebugOutput() {
        // Debug output handled via logger
    }

    startDiscovery() {
        this.discoveryMessageNo = 0;
        this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.discoverySocket.on('message', (message, remote) => {

            this.logger.debug(`SERVER: ${this.config.name} - Discovery request from ${remote.address}:${remote.port}`);

            xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js['processors'].stripPrefix] }, (err, result) => {
                let probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                let probeType = '';
                try {
                    probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                } catch (err) {
                    probeType = '';
                }

                if (typeof probeType === 'object')
                    probeType = probeType._;

                if (probeType === '' || probeType.indexOf('NetworkVideoTransmitter') > -1) {
                    let response =
                        `<?xml version="1.0" encoding="UTF-8"?>
                        <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
                            <SOAP-ENV:Header>
                                <wsa:MessageID>uuid:${uuidv1()}</wsa:MessageID>
                                <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
                                <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
                                <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
                                <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.discoveryMessageNo}" InstanceId="1234567890"/>
                            </SOAP-ENV:Header>
                            <SOAP-ENV:Body>
                                <d:ProbeMatches>
                                    <d:ProbeMatch>
                                        <wsa:EndpointReference>
                                            <wsa:Address>urn:uuid:${this.config.uuid}</wsa:Address>
                                        </wsa:EndpointReference>
                                        <d:Types>dn:NetworkVideoTransmitter</d:Types>
                                        <d:Scopes>
                                            onvif://www.onvif.org/type/video_encoder
                                            onvif://www.onvif.org/type/ptz
                                            onvif://www.onvif.org/hardware/onvif
                                            onvif://www.onvif.org/name/${this.config.name}
                                            onvif://www.onvif.org/location/
                                        </d:Scopes>
                                        <d:XAddrs>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</d:XAddrs>
                                        <d:MetadataVersion>1</d:MetadataVersion>
                                    </d:ProbeMatch>
                                </d:ProbeMatches>
                            </SOAP-ENV:Body>
                        </SOAP-ENV:Envelope>`;

                    this.discoveryMessageNo++;
                    let responseBuffer = Buffer.from(response);
                    return dgram.createSocket('udp4').send(responseBuffer, 0, responseBuffer.length, remote.port, remote.address);
                }
            });
        });

        this.discoverySocket.bind(3702, () => {
            return this.discoverySocket.addMembership('239.255.255.250', this.config.hostname);
        });
    }

    getHostname() {
        return this.config.hostname;
    }
};
