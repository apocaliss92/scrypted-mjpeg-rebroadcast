import sdk, { MediaStreamDestination, ScryptedInterface, Setting, SettingValue, Settings, VideoCamera } from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { MjpegProducer } from './mjpegProducer';
import { FrameHub } from './frameHub';
import { MjpegSourceEnum } from './types';
import crypto from 'crypto';

import type MjpegRebroadcastPlugin from './main';

const { systemManager } = sdk;

interface StreamInfo {
    name: string;
    rtspUrl: string;
    /** Path token extracted from the RTSP rebroadcast URL (already secret) */
    pathToken: string;
}

/**
 * Extract the path segment from an RTSP URL to use as stream token.
 * e.g. rtsp://192.168.1.4:38911/abc123 → abc123
 */
function extractPathToken(rtspUrl: string): string {
    try {
        const url = new URL(rtspUrl);
        return url.pathname.replace(/^\//, '');
    } catch {
        return crypto.randomBytes(16).toString('hex');
    }
}

/** Force-restart FFmpeg after this duration regardless of clients */
const MAX_RUNTIME_MS = 4 * 60 * 60 * 1000; // 4 hours
/** Restart FFmpeg early if 0 clients for this long (prebuffer only) */
const IDLE_RESTART_MS = 30 * 60 * 1000; // 30 minutes
/** How often to check producer health */
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

export class MjpegRebroadcastCameraMixin extends SettingsMixinDeviceBase<any> {
    plugin: MjpegRebroadcastPlugin;
    private logger: {
        log: (...args: any[]) => void;
        debug: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
    private producers: Map<string, MjpegProducer> = new Map();
    private producerStartedAt: Map<string, number> = new Map();
    private discoveredStreams: StreamInfo[] = [];
    private healthCheckInterval: NodeJS.Timeout | null = null;
    killed = false;

    /** Per-stream frame hubs — keyed by pathToken */
    frameHubs: Map<string, FrameHub> = new Map();
    /** Maps pathToken → stream name (for status/display) */
    tokenToName: Map<string, string> = new Map();
    /** Maps stream name → Scrypted MediaStreamDestination (for decoder mode) */
    private streamDestinations: Map<string, MediaStreamDestination> = new Map();

    storageSettings = new StorageSettings(this, {
        mjpegSource: {
            title: 'MJPEG source',
            description: 'Choose how to generate the MJPEG streams',
            type: 'string',
            choices: [
                MjpegSourceEnum.ScryptedSnapshot,
                MjpegSourceEnum.ScryptedRtspFfmpeg,
                MjpegSourceEnum.ScryptedDecoder,
            ],
            defaultValue: MjpegSourceEnum.ScryptedDecoder,
            immediate: true,
            onPut: async () => {
                if (this.storageSettings.values.serverEnabled) {
                    await this.setupStreams();
                    this.onDeviceEvent(ScryptedInterface.Settings, undefined);
                }
            },
        },
        fps: {
            title: 'FPS',
            description: 'Target frames per second',
            type: 'number',
            defaultValue: 5,
        },
        quality: {
            title: 'Quality',
            description: 'JPEG quality (1-100)',
            type: 'number',
            defaultValue: 80,
        },
        width: {
            title: 'Width',
            description: 'Output width (blank for original). Height is auto-calculated.',
            type: 'number',
        },
        prebufferStreams: {
            title: 'Prebuffer streams',
            description: 'Selected streams will have FFmpeg always running (instant playback). Others start on-demand when a client connects.',
            type: 'string',
            multiple: true,
            choices: [],
            immediate: true,
            onPut: async () => {
                if (this.storageSettings.values.serverEnabled) {
                    await this.setupStreams();
                    this.onDeviceEvent(ScryptedInterface.Settings, undefined);
                }
            },
        },
        serverEnabled: {
            title: 'MJPEG server enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
            onPut: async (_oldValue, newValue) => {
                if (newValue) {
                    await this.discoverStreams();
                    await this.setupStreams();
                    this.onDeviceEvent(ScryptedInterface.Settings, undefined);
                } else {
                    await this.teardownStreams();
                    this.onDeviceEvent(ScryptedInterface.Settings, undefined);
                }
            },
        },
        debugEvents: {
            title: 'Debug logging',
            description: 'Enable verbose debug logging',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
    });

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        plugin: MjpegRebroadcastPlugin,
    ) {
        super(options);
        this.plugin = plugin;
        this.plugin.currentMixinsMap[this.id] = this;
        this.logger = {
            log: (message: string, ...args: any[]) =>
                this.console.log(message, ...args),
            debug: (message: string, ...args: any[]) => {
                if (this.storageSettings.values.debugEvents)
                    this.console.log(`[DEBUG] ${message}`, ...args);
            },
            warn: (message: string, ...args: any[]) =>
                this.console.warn(message, ...args),
            error: (message: string, ...args: any[]) =>
                this.console.error(message, ...args),
        };

        setTimeout(() => this.init(), 5000);
    }

    get activeStreamTokens(): string[] {
        return Array.from(this.frameHubs.keys());
    }

    private async init() {
        if (this.killed) return;

        this.console.log(`MJPEG Rebroadcast mixin initialized for ${this.name}`);

        await this.discoverStreams();

        if (this.killed) return;

        if (this.storageSettings.values.serverEnabled) {
            await this.setupStreams();
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const mjpegSource = this.storageSettings.values.mjpegSource;
        const isSnapshot = mjpegSource === MjpegSourceEnum.ScryptedSnapshot;
        const isDecoder = mjpegSource === MjpegSourceEnum.ScryptedDecoder;

        this.storageSettings.settings.fps.hide = isSnapshot || isDecoder;
        this.storageSettings.settings.width.hide = isSnapshot || isDecoder;
        this.storageSettings.settings.quality.hide = isSnapshot || isDecoder;
        this.storageSettings.settings.prebufferStreams.hide = isSnapshot;

        if (this.discoveredStreams.length > 0) {
            this.storageSettings.settings.prebufferStreams.choices = this.discoveredStreams.map(s => s.name);
        }

        const settings = await this.storageSettings.getSettings();

        if (this.frameHubs.size > 0) {
            try {
                const baseEndpoint = await this.plugin.getEndpointUrl();

                for (const [token] of this.frameHubs) {
                    const streamName = this.tokenToName.get(token) ?? token;
                    const url = `${baseEndpoint}/${token}`;
                    settings.push({
                        key: `streamUrl_${token}`,
                        title: `MJPEG Stream Url (${streamName})`,
                        description: url,
                        value: url,
                        type: 'string',
                        readonly: true,
                        subgroup: 'Stream URLs',
                    });
                }
            } catch (e) {
                this.logger.debug(`Could not generate stream URLs: ${(e as Error).message}`);
            }
        }

        return settings;
    }

    async putMixinSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    private async discoverStreams() {
        this.discoveredStreams = [];
        this.streamDestinations.clear();

        try {
            const device = systemManager.getDeviceById(this.id) as unknown as Settings;
            if (!device?.getSettings) return;

            const deviceSettings = await device.getSettings();
            const rtspSettings = deviceSettings.filter(
                (setting) => setting.title === 'RTSP Rebroadcast Url',
            );

            for (const setting of rtspSettings) {
                const rtspUrl = setting.value as string;
                if (!rtspUrl) continue;

                const streamName = setting.subgroup?.replace('Stream: ', '') ?? 'Default';
                const pathToken = extractPathToken(rtspUrl);
                this.discoveredStreams.push({
                    name: streamName,
                    rtspUrl,
                    pathToken,
                });
            }

            // Discover stream destinations for decoder mode
            try {
                const videoDevice = systemManager.getDeviceById(this.id) as unknown as VideoCamera;
                if (videoDevice?.getVideoStreamOptions) {
                    const streamOptions = await videoDevice.getVideoStreamOptions();
                    for (const opt of streamOptions) {
                        if (opt.name && opt.destinations?.length) {
                            this.streamDestinations.set(opt.name, opt.destinations[0]);
                            this.logger.debug(`  destination for "${opt.name}": ${opt.destinations[0]}`);
                        }
                    }
                }
            } catch (e) {
                this.logger.debug(`Could not discover stream destinations: ${(e as Error).message}`);
            }

            this.logger.debug(`${this.name}: found ${this.discoveredStreams.length} RTSP stream(s)`);
            for (const s of this.discoveredStreams) {
                this.logger.debug(`  - ${s.name}: ${s.rtspUrl} (token: ${s.pathToken})`);
            }
        } catch (e) {
            this.console.warn(`Failed to discover streams for ${this.name}: ${(e as Error).message}`);
        }
    }

    /**
     * Map a stream name to its Scrypted MediaStreamDestination (cached during discoverStreams).
     */
    private getStreamDestination(streamName: string): MediaStreamDestination | undefined {
        return this.streamDestinations.get(streamName);
    }

    private getPrebufferStreamNames(): Set<string> {
        const names = this.storageSettings.values.prebufferStreams as string[] | undefined;
        return new Set(names ?? []);
    }

    /**
     * Start a producer for a specific stream token.
     * Called lazily when the first client subscribes.
     * Returns a promise that resolves when the producer is ready.
     */
    private async startProducer(token: string) {
        if (this.producers.has(token)) return; // Already running

        const fps = (this.storageSettings.values.fps as number) || 5;
        const quality = (this.storageSettings.values.quality as number) || 80;
        const width = this.storageSettings.values.width as number;
        const mjpegSource = this.storageSettings.values.mjpegSource;
        const hub = this.frameHubs.get(token);
        if (!hub) return;

        const streamName = this.tokenToName.get(token) ?? token;
        const prebufferNames = this.getPrebufferStreamNames();
        const isPrebuffer = prebufferNames.has(streamName);
        this.console.log(`${this.name}: starting producer for "${streamName}" (${isPrebuffer ? 'prebuffer' : 'first client connected'})`);

        const producer = new MjpegProducer(this.console);
        producer.debugLog = (message, ...args) => this.logger.debug(message, ...args);
        producer.onFrame = (frame) => hub.push(frame);
        this.producers.set(token, producer);
        this.producerStartedAt.set(token, Date.now());

        try {
            if (mjpegSource === MjpegSourceEnum.ScryptedSnapshot) {
                await producer.startSnapshotPolling(this.id, fps);
            } else if (mjpegSource === MjpegSourceEnum.ScryptedDecoder) {
                const stream = this.discoveredStreams.find(s => s.pathToken === token);
                const destination = stream ? this.getStreamDestination(stream.name) : undefined;
                await producer.startDecoderStream(this.id, destination);
            } else {
                const stream = this.discoveredStreams.find(s => s.pathToken === token);
                if (stream) {
                    await producer.startRtspToMjpeg(stream.rtspUrl, fps, quality, width);
                }
            }
        } catch (e) {
            this.console.error(`Failed to start producer for ${streamName}: ${(e as Error).message}`);
        }
    }

    /**
     * Stop a producer for a specific stream token.
     * Called when the last client disconnects.
     */
    private stopProducer(token: string) {
        const producer = this.producers.get(token);
        if (!producer) return;

        const streamName = this.tokenToName.get(token) ?? token;
        this.console.log(`${this.name}: stopping producer for "${streamName}" (no more clients)`);

        producer.stop();
        this.producers.delete(token);
        this.producerStartedAt.delete(token);
    }

    /**
     * Restart a running producer (stop + start).
     * For prebuffer streams this is seamless; for on-demand it only restarts if clients are connected.
     */
    private async restartProducer(token: string) {
        const producer = this.producers.get(token);
        if (!producer) return;

        const streamName = this.tokenToName.get(token) ?? token;
        this.console.log(`${this.name}: restarting producer for "${streamName}"`);

        producer.stop();
        this.producers.delete(token);
        this.producerStartedAt.delete(token);

        await this.startProducer(token);
    }

    /**
     * Periodic health check: restarts producers that have been running too long
     * or that are idle (prebuffer with 0 clients).
     */
    private checkProducerHealth() {
        if (this.killed) return;

        const now = Date.now();
        const prebufferNames = this.getPrebufferStreamNames();

        for (const [token] of this.producers) {
            const startedAt = this.producerStartedAt.get(token);
            if (!startedAt) continue;

            const runtime = now - startedAt;
            const hub = this.frameHubs.get(token);
            const subscribers = hub?.subscriberCount ?? 0;
            const streamName = this.tokenToName.get(token) ?? token;
            const isPrebuffer = prebufferNames.has(streamName);

            if (runtime >= MAX_RUNTIME_MS) {
                this.console.log(`${this.name}: "${streamName}" max runtime reached (${Math.round(runtime / 60000)}min), restarting`);
                this.restartProducer(token);
            } else if (isPrebuffer && subscribers === 0 && runtime >= IDLE_RESTART_MS) {
                this.console.log(`${this.name}: "${streamName}" idle with 0 clients for ${Math.round(runtime / 60000)}min, restarting`);
                this.restartProducer(token);
            }
        }
    }

    /**
     * Set up FrameHubs for ALL discovered streams.
     * Prebuffer streams start FFmpeg immediately; others start lazily on first client.
     */
    private async setupStreams() {
        await this.teardownStreams();

        const mjpegSource = this.storageSettings.values.mjpegSource;

        if (this.discoveredStreams.length === 0 && mjpegSource !== MjpegSourceEnum.ScryptedSnapshot) {
            this.logger.debug(`No streams found for ${this.name}, trying to discover...`);
            await this.discoverStreams();
        }

        const prebufferNames = this.getPrebufferStreamNames();

        try {
            if (mjpegSource === MjpegSourceEnum.ScryptedSnapshot) {
                const token = crypto.randomBytes(16).toString('hex');
                const hub = new FrameHub();
                hub.onFirstSubscriber = () => this.startProducer(token);
                hub.onLastUnsubscribe = () => this.stopProducer(token);
                this.frameHubs.set(token, hub);
                this.tokenToName.set(token, 'Snapshot');

                this.console.log(`${this.name}: MJPEG snapshot endpoint ready (on-demand)`);
            } else if (mjpegSource === MjpegSourceEnum.ScryptedRtspFfmpeg || mjpegSource === MjpegSourceEnum.ScryptedDecoder) {
                if (this.discoveredStreams.length === 0) {
                    this.console.warn(`No streams found for ${this.name}. Make sure the Rebroadcast plugin is installed.`);
                    return;
                }

                const prebufferTokens: string[] = [];

                for (const stream of this.discoveredStreams) {
                    const isPrebuffer = prebufferNames.has(stream.name);
                    const hub = new FrameHub();

                    if (isPrebuffer) {
                        // Prebuffer: no lazy lifecycle — producer starts immediately
                        hub.onFirstSubscriber = null;
                        hub.onLastUnsubscribe = null;
                    } else {
                        // On-demand: lazy start/stop
                        hub.onFirstSubscriber = () => this.startProducer(stream.pathToken);
                        hub.onLastUnsubscribe = () => this.stopProducer(stream.pathToken);
                    }

                    this.frameHubs.set(stream.pathToken, hub);
                    this.tokenToName.set(stream.pathToken, stream.name);

                    if (isPrebuffer) {
                        prebufferTokens.push(stream.pathToken);
                    }
                }

                // Start prebuffer producers immediately
                for (const token of prebufferTokens) {
                    await this.startProducer(token);
                }

                const onDemandCount = this.discoveredStreams.length - prebufferTokens.length;
                const sourceLabel = mjpegSource === MjpegSourceEnum.ScryptedDecoder ? 'decoder' : 'FFmpeg';
                this.console.log(`${this.name}: ${this.discoveredStreams.length} MJPEG endpoint(s) ready via ${sourceLabel} (${prebufferTokens.length} prebuffer, ${onDemandCount} on-demand)`);
            }

            // Start periodic health check for producer restarts
            this.healthCheckInterval = setInterval(() => this.checkProducerHealth(), HEALTH_CHECK_INTERVAL_MS);
        } catch (e) {
            this.console.error(`Failed to setup MJPEG streams for ${this.name}`, (e as Error).message);
        }
    }

    private async teardownStreams() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        for (const [, producer] of this.producers) {
            producer.stop();
        }
        this.producers.clear();
        this.producerStartedAt.clear();
        this.frameHubs.clear();
        this.tokenToName.clear();
    }

    async release() {
        if (this.killed) return;
        this.killed = true;
        this.console.log(`Releasing MJPEG mixin for ${this.name}`);
        await this.teardownStreams();
        super.release();
    }
}
