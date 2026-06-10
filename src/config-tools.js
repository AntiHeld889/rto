const YAML = require('yaml');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const { getIp4FromMac, generateUUIDv4, generateNetworkMac } = require('./net-tools')


function fatalConfigError(logger, message) {
    logger.error(message);
    process.exit(1);
}

function readConfig(logger, configFile) {

    let configData;
    try {
        configData = fs.readFileSync(configFile, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            fatalConfigError(logger, `File not found: ${configFile}`);
        }
        throw error;
    }

    let config;
    try {
        config = YAML.parse(configData);
    } catch (error) {
        fatalConfigError(logger, `Failed to read config, invalid yaml syntax: ${error.message}`);
    }

    return config;
}

function sleep(seconds) {
    spawnSync('sleep', [String(seconds)]);
}


function requireConfigValue(logger, value, path) {
    if (value === undefined || value === null || value === '') {
        fatalConfigError(logger, `Invalid config: missing ${path}.`);
    }
}

function validateOnvifConfig(logger, onvifConfig, index) {
    const prefix = `onvif[${index}]`;

    if (!onvifConfig || typeof onvifConfig !== 'object') {
        fatalConfigError(logger, `Invalid config: ${prefix} must be an object.`);
    }

    requireConfigValue(logger, onvifConfig.name, `${prefix}.name`);
    requireConfigValue(logger, onvifConfig.dev, `${prefix}.dev`);
    requireConfigValue(logger, onvifConfig.target?.hostname, `${prefix}.target.hostname`);
    requireConfigValue(logger, onvifConfig.target?.ports?.rtsp, `${prefix}.target.ports.rtsp`);
    requireConfigValue(logger, onvifConfig.highQuality?.rtsp, `${prefix}.highQuality.rtsp`);
    requireConfigValue(logger, onvifConfig.highQuality?.width, `${prefix}.highQuality.width`);
    requireConfigValue(logger, onvifConfig.highQuality?.height, `${prefix}.highQuality.height`);
    requireConfigValue(logger, onvifConfig.highQuality?.framerate, `${prefix}.highQuality.framerate`);
    requireConfigValue(logger, onvifConfig.highQuality?.bitrate, `${prefix}.highQuality.bitrate`);
    requireConfigValue(logger, onvifConfig.highQuality?.quality, `${prefix}.highQuality.quality`);
    requireConfigValue(logger, onvifConfig.ports?.server, `${prefix}.ports.server`);
    requireConfigValue(logger, onvifConfig.ports?.rtsp, `${prefix}.ports.rtsp`);

    if (onvifConfig.audio) {
        if (onvifConfig.audio.enabled !== undefined && typeof onvifConfig.audio.enabled !== 'boolean') {
            fatalConfigError(logger, `Invalid config: ${prefix}.audio.enabled must be true or false.`);
        }

        if (onvifConfig.audio.encoding !== undefined && !['AAC', 'G711', 'G726'].includes(onvifConfig.audio.encoding)) {
            fatalConfigError(logger, `Invalid config: ${prefix}.audio.encoding must be AAC, G711, or G726.`);
        }
    }
}

function readAndCheckConfig(logger, configFile) {

    
    let config = readConfig(logger, configFile);

    if (!config || !Array.isArray(config.onvif)) {
        fatalConfigError(logger, 'Invalid config: expected an onvif array.');
    }

    let isSaveRequired = false;
    let interfacesCreated = false;
    let proxyCounter = 0;
    for (let onvifConfig of config.onvif) {
        validateOnvifConfig(logger, onvifConfig, proxyCounter);

        //Generate a V4 UUID
        if (!onvifConfig.uuid) {
            let newId = generateUUIDv4();
            logger.info(`CONFIG: UUIDv4 - ${newId}`);
            onvifConfig.uuid = newId;
            isSaveRequired = true;
        }

        // Generate Network MAC for Unicast LAA Prefix
        if (!onvifConfig.mac) {
            let newId = generateNetworkMac();
            logger.info(`CONFIG: MAC - ${newId}`);
            onvifConfig.mac = newId;
            isSaveRequired = true;
        }

        if (!getIp4FromMac(logger, onvifConfig.mac)) {
            const vlanName = `rtsp2onvif_${proxyCounter}`;

            logger.info(`NET_CONF: ADD - ${vlanName} MAC: ${onvifConfig.mac}`);
            try {
                const stdout = execFileSync('ip', ['link', 'add', vlanName, 'link', onvifConfig.dev, 'address', onvifConfig.mac, 'type', 'macvlan', 'mode', 'bridge']);
                logger.debug(stdout);
            } catch (error) {
                logger.warn(`NET_CONF: Failed to create ${vlanName}: ${error.message}`);
            }

            // Use DHCP to obtain IP address (also brings interface up)
            logger.info(`NET_CONF: DHCP - ${vlanName}`);
            try {
                const stdout = execFileSync('dhclient', [vlanName]);
                logger.debug(stdout);
            } catch (error) {
                logger.warn(`NET_CONF: dhclient failed for ${vlanName}: ${error.message}`);
            }

            interfacesCreated = true;
        }
        proxyCounter++
    }

    if (isSaveRequired) {
        writeConfig(logger, configFile, config);
    }

    // Give freshly created interfaces a moment to finish their DHCP setup,
    // even when the config itself did not change (e.g. after a container restart).
    if (isSaveRequired || interfacesCreated) {
        sleep(2);
    }

    return config;
}

function writeConfig(logger, configFile, config) {
    const yamlString = YAML.stringify(config);

    fs.writeFileSync(configFile, yamlString, 'utf8');
    logger.info(`CONFIG: Updated ${configFile}`);
}

module.exports = {
    readAndCheckConfig
}
