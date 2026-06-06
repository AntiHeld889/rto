const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { createRtspProxy } = require('../src/rtsp-proxy');

const silentLogger = {
    debug() {},
    error() {},
    info() {}
};

function listen(server, port, host) {
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
        server.close((error) => error ? reject(error) : resolve());
    });
}

function getFreePort(host) {
    const server = net.createServer();
    return listen(server, 0, host)
        .then(() => {
            const port = server.address().port;
            return close(server).then(() => port);
        });
}

function request(host, port, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });

        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write(payload));
        socket.once('data', response => {
            socket.destroy();
            resolve(response);
        });
        socket.once('error', reject);
    });
}

test('binds proxies to their camera IP so they can share an RTSP port', async (t) => {
    const upstreamOne = net.createServer(socket => socket.pipe(socket));
    const upstreamTwo = net.createServer(socket => {
        socket.setEncoding('utf8');
        socket.on('data', chunk => socket.write(chunk.toUpperCase()));
        socket.on('end', () => socket.end());
    });

    await listen(upstreamOne, 0, '127.0.0.1');
    await listen(upstreamTwo, 0, '127.0.0.1');
    t.after(() => close(upstreamOne));
    t.after(() => close(upstreamTwo));

    const proxyPort = await getFreePort('127.0.0.1');
    const proxyOne = createRtspProxy(
        silentLogger,
        '127.0.0.1',
        proxyPort,
        '127.0.0.1',
        upstreamOne.address().port
    );
    const proxyTwo = createRtspProxy(
        silentLogger,
        '127.0.0.2',
        proxyPort,
        '127.0.0.1',
        upstreamTwo.address().port
    );

    await Promise.all([
        new Promise(resolve => proxyOne.once('listening', resolve)),
        new Promise(resolve => proxyTwo.once('listening', resolve))
    ]);
    t.after(() => close(proxyOne));
    t.after(() => close(proxyTwo));

    const [firstResponse, secondResponse] = await Promise.all([
        request('127.0.0.1', proxyPort, 'camera one'),
        request('127.0.0.2', proxyPort, 'camera two')
    ]);

    assert.equal(firstResponse, 'camera one');
    assert.equal(secondResponse, 'CAMERA TWO');
});
