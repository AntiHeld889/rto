const net = require('net');

function tuneSocket(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
}

function formatEndpoint(socket) {
    return `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
}

function createRtspProxy(logger, sourceHost, sourcePort, targetHost, targetPort) {
    const server = net.createServer({ allowHalfOpen: false }, (clientSocket) => {
        tuneSocket(clientSocket);

        const clientEndpoint = formatEndpoint(clientSocket);
        logger.debug(`RTSP proxy client connected: ${clientEndpoint} -> ${targetHost}:${targetPort}`);

        const targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
            tuneSocket(targetSocket);
            logger.debug(`RTSP proxy upstream connected: ${clientEndpoint} -> ${targetHost}:${targetPort}`);
        });

        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);

        const closeBoth = (source, error) => {
            if (error && error.code !== 'ECONNRESET') {
                logger.debug(`RTSP proxy ${source} error for ${clientEndpoint}: ${error.message}`);
            }

            clientSocket.destroy();
            targetSocket.destroy();
        };

        clientSocket.on('error', (error) => closeBoth('client', error));
        targetSocket.on('error', (error) => closeBoth('upstream', error));

        clientSocket.on('close', () => targetSocket.destroy());
        targetSocket.on('close', () => clientSocket.destroy());
    });

    server.on('error', (error) => {
        logger.error(`RTSP proxy failed on ${sourceHost}:${sourcePort}: ${error.message}`);
    });

    server.listen(sourcePort, sourceHost, () => {
        logger.info(`RTSP proxy listening on ${sourceHost}:${sourcePort} and forwarding to ${targetHost}:${targetPort}`);
    });

    return server;
}

module.exports = {
    createRtspProxy
};
