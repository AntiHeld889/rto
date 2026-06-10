const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const xml2js = require('xml2js');
const { v1: uuidv1 } = require('uuid');

// Inline WSDL templates with runtime XAddr values.
const ONVIF_DEVICE_NAMESPACE = 'http://www.onvif.org/ver10/device/wsdl';
const ONVIF_MEDIA_NAMESPACE = 'http://www.onvif.org/ver10/media/wsdl';
const ONVIF_SCHEMA_NAMESPACE = 'http://www.onvif.org/ver10/schema';
// GetServices reports the implemented Media1/Device service baseline, not the publication date
// of the complete ONVIF specification set.
const ONVIF_SUPPORTED_VERSION = { Major: 2, Minor: 6 };
const MAX_SOAP_BODY_SIZE = 1024 * 1024;


function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function sendTextResponse(response, statusCode, message) {
    if (response.headersSent) {
        response.destroy();
        return;
    }

    response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(message);
}

function readSoapBody(request, response, onComplete) {
    const chunks = [];
    let size = 0;
    let exceededLimit = false;

    request.on('data', chunk => {
        if (exceededLimit) {
            return;
        }

        size += chunk.length;
        if (size > MAX_SOAP_BODY_SIZE) {
            exceededLimit = true;
            chunks.length = 0;
            sendTextResponse(response, 413, 'SOAP request body too large');
            return;
        }

        chunks.push(chunk);
    });

    request.on('end', () => {
        if (!exceededLimit) {
            onComplete(Buffer.concat(chunks, size).toString('utf8'));
        }
    });

    request.on('error', error => {
        if (!response.writableEnded) {
            sendTextResponse(response, 400, `Failed to read request: ${error.message}`);
        }
    });
}

function createServiceWsdl(serviceName, portName, namespace, bindingName, address, importFile) {
    return `<?xml version="1.0" encoding="utf-8" ?>
<wsdl:definitions xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:i0="${namespace}" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:http="http://schemas.xmlsoap.org/wsdl/http/" xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/" xmlns:tns="http://tempuri.org/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tm="http://microsoft.com/wsdl/mime/textMatching/" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" targetNamespace="http://tempuri.org/">
  <wsdl:import namespace="${namespace}" location="https://www.onvif.org/ver10/${importFile}/wsdl/${importFile === 'device' ? 'devicemgmt' : importFile}.wsdl"/>
  <wsdl:service name="${serviceName}">
    <wsdl:port name="${portName}" binding="i0:${bindingName}">
      <soap:address location="${address}"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;
}

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
        this.placeholderSnapshot = null;

        try {
            this.placeholderSnapshot = fs.readFileSync(path.join(__dirname, '..', 'resources', 'snapshot.png'));
        } catch (error) {
            this.logger.warn(`Unable to load placeholder snapshot: ${error.message}`);
        }

        this.config.hostname = getIp4FromMac(logger, this.config.mac);
        if (!this.config.hostname)
            return;

        this.videoSource = {
            token: 'video_src_token',
            Framerate: this.config.highQuality.framerate,
            Resolution: { Width: this.config.highQuality.width, Height: this.config.highQuality.height }
        };

        const configuredAudioSampleRate = this.config.audio?.sampleRate ?? 8;
        const audioSampleRate = configuredAudioSampleRate >= 1000
            ? Math.round(configuredAudioSampleRate / 1000)
            : configuredAudioSampleRate;

        if (configuredAudioSampleRate >= 1000) {
            this.logger.warn(
                `Audio sampleRate ${configuredAudioSampleRate} Hz is deprecated; use ${audioSampleRate} kHz as required by ONVIF Media1.`
            );
        }

        this.audioConfig = {
            enabled: this.config.audio?.enabled !== false,
            encoding: this.config.audio?.encoding || 'AAC',
            bitrate: this.config.audio?.bitrate || 128,
            sampleRate: audioSampleRate
        };

        this.audioSource = {
            token: 'audio_src_token',
            Channels: this.config.audio?.channels || 1
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
                },
                AudioSourceConfiguration: this.createAudioSourceConfiguration('audio_src_hq_config_token', 1),
                AudioEncoderConfiguration: this.createAudioEncoderConfiguration('audio_encoder_hq_config_token', 'CardinalHqAudioConfiguration', 1)
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
                },
                AudioSourceConfiguration: this.createAudioSourceConfiguration('audio_src_lq_config_token', 1),
                AudioEncoderConfiguration: this.createAudioEncoderConfiguration('audio_encoder_lq_config_token', 'CardinalLqAudioConfiguration', 1)
            });
        }
    }

    createAudioSourceConfiguration(token, useCount) {
        return {
            token,
            Name: 'AudioSource',
            UseCount: useCount,
            SourceToken: this.audioSource.token
        };
    }

    createAudioEncoderConfiguration(token, name, useCount) {
        return {
            token,
            Name: name,
            UseCount: useCount,
            Encoding: this.audioConfig.encoding,
            Bitrate: this.audioConfig.bitrate,
            SampleRate: this.audioConfig.sampleRate,
            SessionTimeout: 'PT1000S'
        };
    }

    getAudioConfigurationsXml(profile, indent = '') {
        if (!this.audioConfig.enabled) {
            return '';
        }

        return `
${this.createAudioSourceConfigurationXml(profile, 'tt:AudioSourceConfiguration', indent)}
${this.createAudioEncoderConfigurationXml(profile, 'tt:AudioEncoderConfiguration', indent)}`;
    }

    getDeviceServiceXAddr() {
        return `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`;
    }

    getMediaServiceXAddr() {
        return `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`;
    }

    createDeviceWsdl() {
        return createServiceWsdl('DeviceService', 'Device', ONVIF_DEVICE_NAMESPACE, 'DeviceBinding', this.getDeviceServiceXAddr(), 'device');
    }

    createMediaWsdl() {
        return createServiceWsdl('MediaService', 'Media', ONVIF_MEDIA_NAMESPACE, 'MediaBinding', this.getMediaServiceXAddr(), 'media');
    }

    createSoapEnvelope(body) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="${ONVIF_DEVICE_NAMESPACE}"
    xmlns:trt="${ONVIF_MEDIA_NAMESPACE}"
    xmlns:tt="${ONVIF_SCHEMA_NAMESPACE}">
    <SOAP-ENV:Body>
        ${body}
    </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    }

    createOnvifVersionXml(indent = '') {
        return `${indent}<tt:Major>${ONVIF_SUPPORTED_VERSION.Major}</tt:Major>
${indent}<tt:Minor>${ONVIF_SUPPORTED_VERSION.Minor}</tt:Minor>`;
    }

    createVideoSourceConfigurationXml(profile, elementName = 'tt:VideoSourceConfiguration', indent = '') {
        return `${indent}<${elementName} token="${profile.VideoSourceConfiguration.token}">
${indent}    <tt:Name>${profile.VideoSourceConfiguration.Name}</tt:Name>
${indent}    <tt:UseCount>${profile.VideoSourceConfiguration.UseCount}</tt:UseCount>
${indent}    <tt:SourceToken>${profile.VideoSourceConfiguration.SourceToken}</tt:SourceToken>
${indent}    <tt:Bounds x="${profile.VideoSourceConfiguration.Bounds.x}" y="${profile.VideoSourceConfiguration.Bounds.y}" width="${profile.VideoSourceConfiguration.Bounds.width}" height="${profile.VideoSourceConfiguration.Bounds.height}"/>
${indent}</${elementName}>`;
    }

    createMulticastConfigurationXml(indent = '') {
        return `${indent}<tt:Multicast>
${indent}    <tt:Address>
${indent}        <tt:Type>IPv4</tt:Type>
${indent}        <tt:IPv4Address>0.0.0.0</tt:IPv4Address>
${indent}    </tt:Address>
${indent}    <tt:Port>0</tt:Port>
${indent}    <tt:TTL>0</tt:TTL>
${indent}    <tt:AutoStart>false</tt:AutoStart>
${indent}</tt:Multicast>`;
    }

    createVideoEncoderConfigurationXml(profile, elementName = 'tt:VideoEncoderConfiguration', indent = '') {
        return `${indent}<${elementName} token="${profile.VideoEncoderConfiguration.token}">
${indent}    <tt:Name>${profile.VideoEncoderConfiguration.Name}</tt:Name>
${indent}    <tt:UseCount>${profile.VideoEncoderConfiguration.UseCount}</tt:UseCount>
${indent}    <tt:Encoding>${profile.VideoEncoderConfiguration.Encoding}</tt:Encoding>
${indent}    <tt:Resolution>
${indent}        <tt:Width>${profile.VideoEncoderConfiguration.Resolution.Width}</tt:Width>
${indent}        <tt:Height>${profile.VideoEncoderConfiguration.Resolution.Height}</tt:Height>
${indent}    </tt:Resolution>
${indent}    <tt:Quality>${profile.VideoEncoderConfiguration.Quality}</tt:Quality>
${indent}    <tt:RateControl>
${indent}        <tt:FrameRateLimit>${profile.VideoEncoderConfiguration.RateControl.FrameRateLimit}</tt:FrameRateLimit>
${indent}        <tt:EncodingInterval>${profile.VideoEncoderConfiguration.RateControl.EncodingInterval}</tt:EncodingInterval>
${indent}        <tt:BitrateLimit>${profile.VideoEncoderConfiguration.RateControl.BitrateLimit}</tt:BitrateLimit>
${indent}    </tt:RateControl>
${indent}    <tt:H264>
${indent}        <tt:GovLength>${profile.VideoEncoderConfiguration.H264.GovLength}</tt:GovLength>
${indent}        <tt:H264Profile>${profile.VideoEncoderConfiguration.H264.H264Profile}</tt:H264Profile>
${indent}    </tt:H264>
${this.createMulticastConfigurationXml(`${indent}    `)}
${indent}    <tt:SessionTimeout>${profile.VideoEncoderConfiguration.SessionTimeout}</tt:SessionTimeout>
${indent}</${elementName}>`;
    }

    createAudioSourceConfigurationXml(profile, elementName = 'tt:AudioSourceConfiguration', indent = '') {
        return `${indent}<${elementName} token="${profile.AudioSourceConfiguration.token}">
${indent}    <tt:Name>${profile.AudioSourceConfiguration.Name}</tt:Name>
${indent}    <tt:UseCount>${profile.AudioSourceConfiguration.UseCount}</tt:UseCount>
${indent}    <tt:SourceToken>${profile.AudioSourceConfiguration.SourceToken}</tt:SourceToken>
${indent}</${elementName}>`;
    }

    createAudioEncoderConfigurationXml(profile, elementName = 'tt:AudioEncoderConfiguration', indent = '') {
        return `${indent}<${elementName} token="${profile.AudioEncoderConfiguration.token}">
${indent}    <tt:Name>${profile.AudioEncoderConfiguration.Name}</tt:Name>
${indent}    <tt:UseCount>${profile.AudioEncoderConfiguration.UseCount}</tt:UseCount>
${indent}    <tt:Encoding>${profile.AudioEncoderConfiguration.Encoding}</tt:Encoding>
${indent}    <tt:Bitrate>${profile.AudioEncoderConfiguration.Bitrate}</tt:Bitrate>
${indent}    <tt:SampleRate>${profile.AudioEncoderConfiguration.SampleRate}</tt:SampleRate>
${this.createMulticastConfigurationXml(`${indent}    `)}
${indent}    <tt:SessionTimeout>${profile.AudioEncoderConfiguration.SessionTimeout}</tt:SessionTimeout>
${indent}</${elementName}>`;
    }

    createProfileXml(profile, elementName = 'trt:Profile', indent = '') {
        return `${indent}<${elementName} token="${profile.token}">
${indent}    <tt:Name>${profile.Name}</tt:Name>
${this.createVideoSourceConfigurationXml(profile, 'tt:VideoSourceConfiguration', `${indent}    `)}
${this.createVideoEncoderConfigurationXml(profile, 'tt:VideoEncoderConfiguration', `${indent}    `)}${this.getAudioConfigurationsXml(profile, `${indent}    `)}
${indent}</${elementName}>`;
    }

    handleDeviceService(soapBody) {
        if (soapBody.includes('GetSystemDateAndTime')) {
            let now = new Date();
            let offset = now.getTimezoneOffset();
            let abs_offset = Math.abs(offset);
            let hrs_offset = Math.floor(abs_offset / 60);
            let mins_offset = (abs_offset % 60);
            // POSIX TZ strings invert the sign relative to common UTC notation:
            // getTimezoneOffset() is positive west of UTC, which POSIX writes as "+".
            let tz = 'UTC' + (offset > 0 ? '+' : '-') + hrs_offset + (mins_offset === 0 ? '' : ':' + mins_offset);

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
                    <tds:Model>${escapeXml(this.config.name)}</tds:Model>
                    <tds:FirmwareVersion>1.0.0</tds:FirmwareVersion>
                    <tds:SerialNumber>${escapeXml(this.config.name.replace(/\s+/g, '_'))}-0000</tds:SerialNumber>
                    <tds:HardwareId>${escapeXml(this.config.name.replace(/\s+/g, '_'))}-1001</tds:HardwareId>
                </tds:GetDeviceInformationResponse>
            `);
        } else if (soapBody.includes('GetWsdlUrl')) {
            return this.createSoapEnvelope(`
                <tds:GetWsdlUrlResponse>
                    <tds:WsdlUrl>https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl</tds:WsdlUrl>
                </tds:GetWsdlUrlResponse>
            `);
        } else if (soapBody.includes('GetServiceCapabilities')) {
            return this.createSoapEnvelope(`
                <tds:GetServiceCapabilitiesResponse>
                    <tds:Capabilities>
                        <tds:Network IPFilter="false" ZeroConfiguration="false" IPVersion6="false" DynDNS="false" Dot11Configuration="false" HostnameFromDHCP="false" NTP="0" DHCPv6="false"/>
                        <tds:Security TLS1.1="false" TLS1.2="false" OnboardKeyGeneration="false" AccessPolicyConfig="false" DefaultAccessPolicy="false" Dot1X="false" RemoteUserHandling="false" X.509Token="false" SAMLToken="false" KerberosToken="false" UsernameToken="false" HttpDigest="false" RELToken="false"/>
                        <tds:System DiscoveryResolve="false" DiscoveryBye="false" RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" FirmwareUpgrade="false" HttpFirmwareUpgrade="false" HttpSystemBackup="false" HttpSystemLogging="false" HttpSupportInformation="false"/>
                    </tds:Capabilities>
                </tds:GetServiceCapabilitiesResponse>
            `);
        } else if (soapBody.includes('GetScopes')) {
            return this.createSoapEnvelope(`
                <tds:GetScopesResponse>
                    <tds:Scopes>
                        <tt:ScopeDef>Fixed</tt:ScopeDef>
                        <tt:ScopeItem>onvif://www.onvif.org/type/video_encoder</tt:ScopeItem>
                    </tds:Scopes>
                    <tds:Scopes>
                        <tt:ScopeDef>Configurable</tt:ScopeDef>
                        <tt:ScopeItem>onvif://www.onvif.org/name/${escapeXml(encodeURIComponent(this.config.name))}</tt:ScopeItem>
                    </tds:Scopes>
                    <tds:Scopes>
                        <tt:ScopeDef>Fixed</tt:ScopeDef>
                        <tt:ScopeItem>onvif://www.onvif.org/hardware/rtsp-to-onvif</tt:ScopeItem>
                    </tds:Scopes>
                </tds:GetScopesResponse>
            `);
        } else if (soapBody.includes('GetHostname')) {
            return this.createSoapEnvelope(`
                <tds:GetHostnameResponse>
                    <tds:HostnameInformation>
                        <tt:FromDHCP>false</tt:FromDHCP>
                        <tt:Name>${escapeXml(this.config.name)}</tt:Name>
                    </tds:HostnameInformation>
                </tds:GetHostnameResponse>
            `);
        } else if (soapBody.includes('GetCapabilities')) {
            return this.createSoapEnvelope(`
                <tds:GetCapabilitiesResponse>
                    <tds:Capabilities>
                        <tt:Device>
                            <tt:XAddr>${this.getDeviceServiceXAddr()}</tt:XAddr>
                            <tt:System>
                                <tt:DiscoveryResolve>false</tt:DiscoveryResolve>
                                <tt:DiscoveryBye>false</tt:DiscoveryBye>
                                <tt:RemoteDiscovery>false</tt:RemoteDiscovery>
                                <tt:SystemBackup>false</tt:SystemBackup>
                                <tt:SystemLogging>false</tt:SystemLogging>
                                <tt:FirmwareUpgrade>false</tt:FirmwareUpgrade>
                                <tt:SupportedVersions>
                                    ${this.createOnvifVersionXml('                                    ')}
                                </tt:SupportedVersions>
                            </tt:System>
                        </tt:Device>
                        <tt:Media>
                            <tt:XAddr>${this.getMediaServiceXAddr()}</tt:XAddr>
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
                                <trt:ProfileCapabilities MaximumNumberOfProfiles="${this.profiles.length}"/>
                                <trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="true" RTP_RTSP_TCP="true"/>
                            </trt:Capabilities>
                        </tds:Capabilities>` : '';

            return this.createSoapEnvelope(`
                <tds:GetServicesResponse>
                    <tds:Service>
                        <tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>
                        <tds:XAddr>${this.getDeviceServiceXAddr()}</tds:XAddr>
                        <tds:Version>
                            ${this.createOnvifVersionXml('                            ')}
                        </tds:Version>
                    </tds:Service>
                    <tds:Service>
                        <tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>
                        <tds:XAddr>${this.getMediaServiceXAddr()}</tds:XAddr>
                        <tds:Version>
                            ${this.createOnvifVersionXml('                            ')}
                        </tds:Version>${mediaCapabilities}
                    </tds:Service>
                </tds:GetServicesResponse>
            `);
        }

        return null;
    }

    handleMediaService(soapBody) {
        if (soapBody.includes('GetServiceCapabilities')) {
            return this.createSoapEnvelope(`
                <trt:GetServiceCapabilitiesResponse>
                    <trt:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false">
                        <trt:ProfileCapabilities MaximumNumberOfProfiles="${this.profiles.length}"/>
                        <trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="true" RTP_RTSP_TCP="true" NonAggregateControl="false"/>
                    </trt:Capabilities>
                </trt:GetServiceCapabilitiesResponse>
            `);
        } else if (soapBody.includes('GetProfile') && !soapBody.includes('GetProfiles')) {
            // GetProfile (single) - return specific profile by token
            let profileToken = 'main_stream';
            if (soapBody.includes('sub_stream')) {
                profileToken = 'sub_stream';
            }
            const profile = this.profiles.find(p => p.token === profileToken) || this.profiles[0];

            return this.createSoapEnvelope(`
                <trt:GetProfileResponse>
${this.createProfileXml(profile, 'trt:Profile', '                    ')}
                </trt:GetProfileResponse>
            `);
        } else if (soapBody.includes('GetProfiles')) {
            const profilesXml = this.profiles.map(profile => this.createProfileXml(profile, 'trt:Profiles', '                    ')).join('\n');

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
        } else if (soapBody.includes('GetVideoSourceConfigurations')) {
            const configsXml = this.profiles.map(profile => this.createVideoSourceConfigurationXml(profile, 'trt:Configurations', '                    ')).join('\n');

            return this.createSoapEnvelope(`
                <trt:GetVideoSourceConfigurationsResponse>
${configsXml}
                </trt:GetVideoSourceConfigurationsResponse>
            `);
        } else if (soapBody.includes('GetVideoSourceConfiguration')) {
            let profile = this.profiles[0];
            const requestedProfile = this.profiles.find(candidate => soapBody.includes(candidate.VideoSourceConfiguration.token));
            if (requestedProfile) {
                profile = requestedProfile;
            }

            return this.createSoapEnvelope(`
                <trt:GetVideoSourceConfigurationResponse>
${this.createVideoSourceConfigurationXml(profile, 'trt:Configuration', '                    ')}
                </trt:GetVideoSourceConfigurationResponse>
            `);
        } else if (soapBody.includes('GetVideoEncoderConfigurations')) {
            const configsXml = this.profiles.map(profile => this.createVideoEncoderConfigurationXml(profile, 'trt:Configurations', '                    ')).join('\n');

            return this.createSoapEnvelope(`
                <trt:GetVideoEncoderConfigurationsResponse>
${configsXml}
                </trt:GetVideoEncoderConfigurationsResponse>
            `);
        } else if (soapBody.includes('GetVideoEncoderConfigurationOptions')) {
            const maxWidth = Math.max(...this.profiles.map(profile => profile.VideoEncoderConfiguration.Resolution.Width));
            const maxHeight = Math.max(...this.profiles.map(profile => profile.VideoEncoderConfiguration.Resolution.Height));
            const maxFrameRate = Math.max(...this.profiles.map(profile => profile.VideoEncoderConfiguration.RateControl.FrameRateLimit));
            const maxBitrate = Math.max(...this.profiles.map(profile => profile.VideoEncoderConfiguration.RateControl.BitrateLimit));

            return this.createSoapEnvelope(`
                <trt:GetVideoEncoderConfigurationOptionsResponse>
                    <trt:Options>
                        <tt:QualityRange>
                            <tt:Min>1</tt:Min>
                            <tt:Max>10</tt:Max>
                        </tt:QualityRange>
                        <tt:H264>
                            <tt:ResolutionsAvailable>
                                <tt:Width>${maxWidth}</tt:Width>
                                <tt:Height>${maxHeight}</tt:Height>
                            </tt:ResolutionsAvailable>
                            <tt:GovLengthRange>
                                <tt:Min>1</tt:Min>
                                <tt:Max>${maxFrameRate}</tt:Max>
                            </tt:GovLengthRange>
                            <tt:FrameRateRange>
                                <tt:Min>1</tt:Min>
                                <tt:Max>${maxFrameRate}</tt:Max>
                            </tt:FrameRateRange>
                            <tt:EncodingIntervalRange>
                                <tt:Min>1</tt:Min>
                                <tt:Max>1</tt:Max>
                            </tt:EncodingIntervalRange>
                            <tt:H264ProfilesSupported>Main</tt:H264ProfilesSupported>
                        </tt:H264>
                        <tt:Extension>
                            <tt:H264>
                                <tt:BitrateRange>
                                    <tt:Min>1</tt:Min>
                                    <tt:Max>${maxBitrate}</tt:Max>
                                </tt:BitrateRange>
                            </tt:H264>
                        </tt:Extension>
                    </trt:Options>
                </trt:GetVideoEncoderConfigurationOptionsResponse>
            `);
        } else if (soapBody.includes('GetVideoEncoderConfiguration')) {
            let profile = this.profiles[0];
            const requestedProfile = this.profiles.find(candidate => soapBody.includes(candidate.VideoEncoderConfiguration.token));
            if (requestedProfile) {
                profile = requestedProfile;
            }

            return this.createSoapEnvelope(`
                <trt:GetVideoEncoderConfigurationResponse>
${this.createVideoEncoderConfigurationXml(profile, 'trt:Configuration', '                    ')}
                </trt:GetVideoEncoderConfigurationResponse>
            `);
        } else if (soapBody.includes('GetAudioSources')) {
            const sourcesXml = this.audioConfig.enabled ? `
                    <trt:AudioSources token="${this.audioSource.token}">
                        <tt:Channels>${this.audioSource.Channels}</tt:Channels>
                    </trt:AudioSources>` : '';

            return this.createSoapEnvelope(`
                <trt:GetAudioSourcesResponse>${sourcesXml}
                </trt:GetAudioSourcesResponse>
            `);
        } else if (soapBody.includes('GetAudioSourceConfigurations')) {
            const configsXml = this.audioConfig.enabled
                ? this.profiles.map(profile => this.createAudioSourceConfigurationXml(profile, 'trt:Configurations', '                    ')).join('\n')
                : '';

            return this.createSoapEnvelope(`
                <trt:GetAudioSourceConfigurationsResponse>
${configsXml}
                </trt:GetAudioSourceConfigurationsResponse>
            `);
        } else if (soapBody.includes('GetAudioEncoderConfigurations')) {
            const configsXml = this.audioConfig.enabled
                ? this.profiles.map(profile => this.createAudioEncoderConfigurationXml(profile, 'trt:Configurations', '                    ')).join('\n')
                : '';

            return this.createSoapEnvelope(`
                <trt:GetAudioEncoderConfigurationsResponse>
${configsXml}
                </trt:GetAudioEncoderConfigurationsResponse>
            `);
        } else if (soapBody.includes('GetAudioEncoderConfigurationOptions')) {
            return this.createSoapEnvelope(`
                <trt:GetAudioEncoderConfigurationOptionsResponse>
                    <trt:Options>
                        <tt:Options>
                            <tt:Encoding>${this.audioConfig.encoding}</tt:Encoding>
                            <tt:BitrateList>
                                <tt:Items>${this.audioConfig.bitrate}</tt:Items>
                            </tt:BitrateList>
                            <tt:SampleRateList>
                                <tt:Items>${this.audioConfig.sampleRate}</tt:Items>
                            </tt:SampleRateList>
                        </tt:Options>
                    </trt:Options>
                </trt:GetAudioEncoderConfigurationOptionsResponse>
            `);
        } else if (soapBody.includes('GetAudioEncoderConfiguration')) {
            let profile = this.profiles[0];
            const requestedProfile = this.profiles.find(candidate => soapBody.includes(candidate.AudioEncoderConfiguration.token));
            if (requestedProfile) {
                profile = requestedProfile;
            }

            return this.createSoapEnvelope(`
                <trt:GetAudioEncoderConfigurationResponse>
${this.createAudioEncoderConfigurationXml(profile, 'trt:Configuration', '                    ')}
                </trt:GetAudioEncoderConfigurationResponse>
            `);
        } else if (soapBody.includes('GetAudioSourceConfiguration')) {
            let profile = this.profiles[0];
            const requestedProfile = this.profiles.find(candidate => soapBody.includes(candidate.AudioSourceConfiguration.token));
            if (requestedProfile) {
                profile = requestedProfile;
            }

            return this.createSoapEnvelope(`
                <trt:GetAudioSourceConfigurationResponse>
${this.createAudioSourceConfigurationXml(profile, 'trt:Configuration', '                    ')}
                </trt:GetAudioSourceConfigurationResponse>
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
                        <tt:Uri>${escapeXml(`rtsp://${this.config.hostname}:${this.config.ports.rtsp}${rtspPath}`)}</tt:Uri>
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
                        <tt:Uri>${escapeXml(uri)}</tt:Uri>
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

        const servePlaceholder = (response) => {
            if (!this.placeholderSnapshot) {
                sendTextResponse(response, 404, 'Snapshot not found');
                return;
            }

            response.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': this.placeholderSnapshot.length,
                'Cache-Control': 'no-cache'
            });
            response.end(this.placeholderSnapshot);
        };

        const handleSoapRequest = (request, response, serviceName, handler) => {
            if (request.method === 'GET') {
                response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
                response.end(serviceName === 'device_service' ? this.createDeviceWsdl() : this.createMediaWsdl());
                return;
            }

            if (request.method !== 'POST') {
                response.writeHead(405, {
                    Allow: 'GET, POST',
                    'Content-Type': 'text/plain; charset=utf-8'
                });
                response.end('Method not allowed');
                return;
            }

            readSoapBody(request, response, body => {
                const actionMatch = body.match(/<(?:\w+:)?(Get\w+|Set\w+|Create\w+|Delete\w+)/i);
                const action = actionMatch ? actionMatch[1] : 'unknown';
                const clientIp = request.socket.remoteAddress;

                this.logger.info(`SOAP ${serviceName}: ${action} from ${clientIp}`);
                this.logger.debug(`SOAP Request:\n${body}`);

                const soapResponse = handler.call(this, body);
                if (soapResponse) {
                    this.logger.debug(`SOAP Response:\n${soapResponse}`);
                    response.writeHead(200, {
                        'Content-Type': 'application/soap+xml; charset=utf-8'
                    });
                    response.end(soapResponse);
                    return;
                }

                this.logger.warn(`Unknown SOAP action in ${serviceName}: ${action}`);
                sendTextResponse(response, 500, 'Unknown SOAP action');
            });
        };

        this.server = http.createServer((request, response) => {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const clientIp = request.socket.remoteAddress;

            this.logger.debug(`HTTP ${request.method} ${pathname} from ${clientIp}`);

            if (pathname === '/snapshot.png') {
                if (request.method !== 'GET') {
                    response.writeHead(405, { Allow: 'GET' });
                    response.end();
                    return;
                }

                servePlaceholder(response);
                return;
            }

            if (pathname === '/snapshot') {
                if (request.method !== 'GET') {
                    response.writeHead(405, { Allow: 'GET' });
                    response.end();
                    return;
                }

                this.logger.info(`Snapshot request from ${clientIp}`);

                const snapshotPath = this.config.highQuality?.snapshot;
                if (!snapshotPath || !this.config.target?.hostname || !this.config.target?.ports?.snapshot) {
                    this.logger.warn('Snapshot config missing, serving placeholder');
                    servePlaceholder(response);
                    return;
                }

                const targetUrl = new URL(snapshotPath, `http://${this.config.target.hostname}:${this.config.target.ports.snapshot}`);
                this.logger.debug(`Proxying snapshot from ${targetUrl}`);

                const proxyHeaders = {};
                if (request.headers.authorization) {
                    proxyHeaders.Authorization = request.headers.authorization;
                }

                const proxyRequest = http.get(targetUrl, { headers: proxyHeaders }, proxyResponse => {
                    const headers = {
                        'Content-Type': proxyResponse.headers['content-type'] || 'image/jpeg',
                        'Cache-Control': 'no-cache'
                    };

                    if (proxyResponse.headers['content-length']) {
                        headers['Content-Length'] = proxyResponse.headers['content-length'];
                    }
                    if (proxyResponse.headers['www-authenticate']) {
                        headers['WWW-Authenticate'] = proxyResponse.headers['www-authenticate'];
                    }

                    this.logger.debug(`Streaming snapshot with status ${proxyResponse.statusCode}`);
                    response.writeHead(proxyResponse.statusCode || 502, headers);
                    proxyResponse.pipe(response);
                    proxyResponse.on('error', error => {
                        this.logger.error(`Snapshot proxy error: ${error.message}`);
                        if (!response.writableEnded) {
                            response.destroy(error);
                        }
                    });
                });

                proxyRequest.setTimeout(10000, () => {
                    proxyRequest.destroy(new Error('Snapshot request timed out'));
                });

                proxyRequest.on('error', error => {
                    this.logger.error(`Snapshot request error: ${error.message}`);
                    if (!response.writableEnded) {
                        sendTextResponse(response, 502, 'Snapshot request error');
                    }
                });

                response.on('close', () => {
                    if (!response.writableEnded) {
                        proxyRequest.destroy();
                    }
                });
                return;
            }

            if (pathname === '/onvif/device_service') {
                handleSoapRequest(request, response, 'device_service', this.handleDeviceService);
                return;
            }

            if (pathname === '/onvif/media_service') {
                handleSoapRequest(request, response, 'media_service', this.handleMediaService);
                return;
            }

            sendTextResponse(response, 404, 'Not found');
        });

        this.server.on('error', error => {
            this.logger.error(`SERVER: ${this.config.name} - HTTP server error on ${this.config.hostname}:${this.config.ports.server}: ${error.message}`);
        });

        this.server.listen(this.config.ports.server, this.config.hostname);
    }

    enableDebugOutput() {
        // Debug output handled via logger
    }

    startDiscovery() {
        this.discoveryMessageNo = 0;
        this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.discoverySocket.on('error', error => {
            this.logger.error(`SERVER: ${this.config.name} - Discovery socket error: ${error.message}`);
        });

        this.discoverySocket.on('message', (message, remote) => {

            this.logger.debug(`SERVER: ${this.config.name} - Discovery request from ${remote.address}:${remote.port}`);

            xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js['processors'].stripPrefix] }, (err, result) => {
                if (err || !result?.Envelope?.Header?.[0]?.MessageID?.[0]) {
                    this.logger.debug(`SERVER: ${this.config.name} - Invalid discovery probe: ${err ? err.message : 'missing MessageID'}`);
                    return;
                }

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
                                <wsa:RelatesTo>${escapeXml(probeUuid)}</wsa:RelatesTo>
                                <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
                                <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
                                <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.discoveryMessageNo}" InstanceId="1234567890"/>
                            </SOAP-ENV:Header>
                            <SOAP-ENV:Body>
                                <d:ProbeMatches>
                                    <d:ProbeMatch>
                                        <wsa:EndpointReference>
                                            <wsa:Address>urn:uuid:${escapeXml(this.config.uuid)}</wsa:Address>
                                        </wsa:EndpointReference>
                                        <d:Types>dn:NetworkVideoTransmitter</d:Types>
                                        <d:Scopes>
                                            onvif://www.onvif.org/type/video_encoder
                                            onvif://www.onvif.org/type/ptz
                                            onvif://www.onvif.org/hardware/onvif
                                            onvif://www.onvif.org/name/${escapeXml(encodeURIComponent(this.config.name))}
                                            onvif://www.onvif.org/location/
                                        </d:Scopes>
                                        <d:XAddrs>${escapeXml(this.getDeviceServiceXAddr())}</d:XAddrs>
                                        <d:MetadataVersion>1</d:MetadataVersion>
                                    </d:ProbeMatch>
                                </d:ProbeMatches>
                            </SOAP-ENV:Body>
                        </SOAP-ENV:Envelope>`;

                    this.discoveryMessageNo++;
                    let responseBuffer = Buffer.from(response);
                    const responseSocket = dgram.createSocket('udp4');
                    return responseSocket.send(responseBuffer, 0, responseBuffer.length, remote.port, remote.address, () => {
                        responseSocket.close();
                    });
                }
            });
        });

        this.discoverySocket.bind(3702, () => {
            try {
                this.discoverySocket.addMembership('239.255.255.250', this.config.hostname);
            } catch (error) {
                this.logger.error(`SERVER: ${this.config.name} - Failed to join discovery multicast group on ${this.config.hostname}: ${error.message}`);
            }
        });
    }

    getHostname() {
        return this.config.hostname;
    }
};
