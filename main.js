const argparse = require('argparse');
const winston = require('winston');

const OnvifServer = require('./src/onvif-server');
const { createRtspProxy } = require('./src/rtsp-proxy');
const { readAndCheckConfig } = require('./src/config-tools');

const logger = winston.createLogger({
    level: process.env.DEBUG ? 'debug' : 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level.toUpperCase().padEnd(5)} ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console()
    ]
});

const parser = new argparse.ArgumentParser({
    description: 'Virtual RTSP to ONVIF proxy'
});

parser.add_argument('config', { help: 'config filename to use', nargs: '?' });

const args = parser.parse_args();

if (args) {

    if (!args.config) {
        logger.error('Please specify a config filename!');
        process.exitCode = 1;
        return;
    }

    const config = readAndCheckConfig(logger, args.config);

    for (let onvifConfig of config.onvif) {

        let server = new OnvifServer(logger, onvifConfig);

        if (server.getHostname()) {

            logger.info('');
            server.startHttpServer();
            server.startDiscovery();
            if (process.env.DEBUG)
                server.enableDebugOutput()

            if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp) {
                logger.info(`PROXY: ${server.getHostname()}:${onvifConfig.ports.rtsp} --> ${onvifConfig.target.hostname}:${onvifConfig.target.ports.rtsp}`);
                createRtspProxy(
                    logger,
                    server.getHostname(),
                    onvifConfig.ports.rtsp,
                    onvifConfig.target.hostname,
                    onvifConfig.target.ports.rtsp
                );
            }
            // Note: snapshot is now handled via HTTP proxy endpoint /snapshot on the server port,
            // so we no longer need a TCP proxy for snapshot
        } else {
            logger.error(`Failed to find IP address for MAC address ${onvifConfig.mac}`)
            // Already-started servers would keep the event loop alive, so exit explicitly.
            process.exit(1);
        }
    }
}
