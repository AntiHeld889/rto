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

function request({ host, port, path, method = 'GET', body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path, method }, response => {
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

