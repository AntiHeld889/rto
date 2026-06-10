const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const test = require('node:test');

const OnvifServer = require('../src/onvif-server');

const silentLogger = {
    debug() {},
    error() {},
    info() {},
    warn() {}
};

function getLocalInterface() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        const address = addresses.find(candidate => candidate.family === 'IPv4');
        if (address) {
            return address;
        }
    }

    throw new Error('No IPv4 interface available for test');
}

function createConfig(overrides = {}) {
    const network = getLocalInterface();
    const { target = {}, highQuality = {}, ports = {}, ...configOverrides } = overrides;

    return {
        name: 'TestCamera',
        mac: network.mac,
        uuid: '591aac06-f2a1-4b6a-a67f-c224c12b8512',
        target: {
            hostname: '127.0.0.1',
            ports: { rtsp: 554 },
            ...target
        },
        highQuality: {
            rtsp: '/stream',
            width: 1920,
            height: 1080,
            framerate: 25,
            bitrate: 4096,
            quality: 4,
            ...highQuality
        },
        ports: { server: 0, rtsp: 8554, ...ports },
        ...configOverrides
    };
}

function listen(server, port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function request({ host, port, path, method = 'GET', headers, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path, method, headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks)
            }));
        });

        req.on('error', reject);
        if (body) {
            req.end(body);
        } else {
            req.end();
        }
    });
}

async function startOnvifServer(t, config) {
    const server = new OnvifServer(silentLogger, config);
    server.startHttpServer();
    await new Promise((resolve, reject) => {
        server.server.once('listening', resolve);
        server.server.once('error', reject);
    });
    t.after(() => close(server.server));
    return server;
}

test('returns 405 for unsupported SOAP methods instead of leaving the request open', async (t) => {
    const server = await startOnvifServer(t, createConfig());
    const response = await request({
        host: server.getHostname(),
        port: server.server.address().port,
        path: '/onvif/device_service',
        method: 'PUT'
    });

    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'GET, POST');
});

test('rejects oversized SOAP request bodies', async (t) => {
    const server = await startOnvifServer(t, createConfig());
    const response = await request({
        host: server.getHostname(),
        port: server.server.address().port,
        path: '/onvif/media_service',
        method: 'POST',
        body: Buffer.alloc(1024 * 1024 + 1, 'x')
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.body.toString(), 'SOAP request body too large');
});

test('streams snapshot response headers and body from the upstream camera', async (t) => {
    const snapshot = Buffer.alloc(256 * 1024, 7);
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': snapshot.length
        });
        res.end(snapshot);
    });
    await listen(upstream);
    t.after(() => close(upstream));

    const config = createConfig({
        target: {
            hostname: '127.0.0.1',
            ports: {
                rtsp: 554,
                snapshot: upstream.address().port
            }
        },
        highQuality: { snapshot: '/camera.jpg' }
    });
    const server = await startOnvifServer(t, config);
    const response = await request({
        host: server.getHostname(),
        port: server.server.address().port,
        path: '/snapshot'
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(Number(response.headers['content-length']), snapshot.length);
    assert.deepEqual(response.body, snapshot);
});

test('forwards snapshot authentication headers in both directions', async (t) => {
    const authorization = 'Basic dXNlcjpwYXNzd29yZA==';
    const challenge = 'Basic realm="camera"';
    const snapshot = Buffer.from('authenticated snapshot');
    const upstream = http.createServer((req, res) => {
        if (req.headers.authorization !== authorization) {
            res.writeHead(401, { 'WWW-Authenticate': challenge });
            res.end('Authentication required');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(snapshot);
    });
    await listen(upstream);
    t.after(() => close(upstream));

    const config = createConfig({
        target: {
            hostname: '127.0.0.1',
            ports: {
                rtsp: 554,
                snapshot: upstream.address().port
            }
        },
        highQuality: { snapshot: '/protected.jpg' }
    });
    const server = await startOnvifServer(t, config);
    const endpoint = {
        host: server.getHostname(),
        port: server.server.address().port,
        path: '/snapshot'
    };

    const unauthorizedResponse = await request(endpoint);
    assert.equal(unauthorizedResponse.statusCode, 401);
    assert.equal(unauthorizedResponse.headers['www-authenticate'], challenge);

    const authorizedResponse = await request({
        ...endpoint,
        headers: { Authorization: authorization }
    });
    assert.equal(authorizedResponse.statusCode, 200);
    assert.deepEqual(authorizedResponse.body, snapshot);
});

test('advertises schema-compliant ONVIF audio metadata in kHz', () => {
    const server = new OnvifServer(silentLogger, createConfig({
        audio: {
            enabled: true,
            encoding: 'G711',
            bitrate: 64,
            sampleRate: 8,
            channels: 1
        }
    }));

    const response = server.handleMediaService('<trt:GetProfiles/>');

    assert.match(response, /<tt:AudioSourceConfiguration token="audio_src_hq_config_token">/);
    assert.match(
        response,
        /<tt:AudioEncoderConfiguration token="audio_encoder_hq_config_token">[\s\S]*?<tt:Encoding>G711<\/tt:Encoding>[\s\S]*?<tt:Bitrate>64<\/tt:Bitrate>[\s\S]*?<tt:SampleRate>8<\/tt:SampleRate>[\s\S]*?<tt:Multicast>[\s\S]*?<tt:IPv4Address>0\.0\.0\.0<\/tt:IPv4Address>[\s\S]*?<tt:AutoStart>false<\/tt:AutoStart>[\s\S]*?<\/tt:Multicast>[\s\S]*?<\/tt:AudioEncoderConfiguration>/
    );
});

test('normalizes legacy audio sample rates in Hz to ONVIF kHz', () => {
    const warnings = [];
    const logger = {
        ...silentLogger,
        warn(message) {
            warnings.push(message);
        }
    };
    const server = new OnvifServer(logger, createConfig({
        audio: { enabled: true, sampleRate: 48000 }
    }));

    const response = server.handleMediaService('<trt:GetAudioEncoderConfigurations/>');

    assert.match(response, /<tt:SampleRate>48<\/tt:SampleRate>/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /48000 Hz is deprecated; use 48 kHz/);
});

test('reports the timezone with POSIX sign convention in GetSystemDateAndTime', () => {
    const server = new OnvifServer(silentLogger, createConfig());

    const response = server.handleDeviceService('<tds:GetSystemDateAndTime/>');

    // POSIX TZ strings invert the sign: west of UTC (positive getTimezoneOffset) is "+".
    const expectedSign = new Date().getTimezoneOffset() > 0 ? '\\+' : '-';
    assert.match(response, new RegExp(`<tt:TZ>UTC${expectedSign}\\d`));
});

test('returns a single video source configuration by token', () => {
    const server = new OnvifServer(silentLogger, createConfig());

    const response = server.handleMediaService(
        '<trt:GetVideoSourceConfiguration><trt:ConfigurationToken>video_src_config_token</trt:ConfigurationToken></trt:GetVideoSourceConfiguration>'
    );

    assert.match(response, /<trt:GetVideoSourceConfigurationResponse>/);
    assert.match(response, /<trt:Configuration token="video_src_config_token">/);
});

test('orders profile configurations according to the ONVIF schema sequence', () => {
    const server = new OnvifServer(silentLogger, createConfig({
        audio: { enabled: true }
    }));

    const response = server.handleMediaService('<trt:GetProfiles/>');

    // xs:sequence: Name, VideoSourceConfiguration, AudioSourceConfiguration,
    // VideoEncoderConfiguration, AudioEncoderConfiguration
    assert.match(
        response,
        /<tt:Name>MainStream<\/tt:Name>[\s\S]*?<tt:VideoSourceConfiguration[\s\S]*?<tt:AudioSourceConfiguration[\s\S]*?<tt:VideoEncoderConfiguration[\s\S]*?<tt:AudioEncoderConfiguration/
    );
});

test('answers GetVideoSourceConfigurationOptions instead of the singular configuration', () => {
    const server = new OnvifServer(silentLogger, createConfig());

    const response = server.handleMediaService('<trt:GetVideoSourceConfigurationOptions/>');

    assert.match(response, /<trt:GetVideoSourceConfigurationOptionsResponse>/);
    assert.match(response, /<tt:VideoSourceTokensAvailable>video_src_token<\/tt:VideoSourceTokensAvailable>/);
    assert.doesNotMatch(response, /<trt:GetVideoSourceConfigurationResponse>/);
});

test('answers GetAudioSourceConfigurationOptions instead of the singular configuration', () => {
    const server = new OnvifServer(silentLogger, createConfig({
        audio: { enabled: true }
    }));

    const response = server.handleMediaService('<trt:GetAudioSourceConfigurationOptions/>');

    assert.match(response, /<trt:GetAudioSourceConfigurationOptionsResponse>/);
    assert.match(response, /<tt:InputTokensAvailable>audio_src_token<\/tt:InputTokensAvailable>/);
    assert.doesNotMatch(response, /<trt:GetAudioSourceConfigurationResponse>/);
});

test('does not advertise PTZ in discovery scopes', () => {
    // The discovery response template lives in startDiscovery; assert on the
    // source to keep the test free of multicast sockets.
    const fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('../src/onvif-server.js'), 'utf8');
    assert.doesNotMatch(source, /onvif:\/\/www\.onvif\.org\/type\/ptz/);
});

test('omits ONVIF audio configurations when audio is disabled', () => {
    const server = new OnvifServer(silentLogger, createConfig({
        audio: { enabled: false }
    }));

    const response = server.handleMediaService('<trt:GetProfiles/>');

    assert.doesNotMatch(response, /AudioSourceConfiguration/);
    assert.doesNotMatch(response, /AudioEncoderConfiguration/);
});
