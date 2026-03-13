import sdk, { Setting, SettingValue, ScryptedInterface, Settings } from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { MjpegServer } from './mjpegServer';
import { MjpegProducer } from './mjpegProducer';
import { MjpegSourceEnum } from './types';

import type MjpegRebroadcastPlugin from './main';

const { systemManager } = sdk;

interface RtspStreamInfo {
    name: string;
    rtspUrl: string;
}

export class MjpegRebroadcastCameraMixin extends SettingsMixinDeviceBase<any> {
    private plugin: MjpegRebroadcastPlugin;
    private mjpegServer: MjpegServer;
    private producers: Map<string, MjpegProducer> = new Map();
    private discoveredStreams: RtspStreamInfo[] = [];
    private killed = false;

    storageSettings = new StorageSettings(this, {
        mjpegSource: {
            title: 'MJPEG source',
            description: 'Choose how to generate the MJPEG streams',
            type: 'string',
            choices: [
                MjpegSourceEnum.ScryptedSnapshot,
                MjpegSourceEnum.ScryptedRtspFfmpeg,
            ],
            defaultValue: MjpegSourceEnum.ScryptedRtspFfmpeg,
            immediate: true,
        },
        serverPort: {
            title: 'Server port',
            description: 'HTTP port for this camera MJPEG server (0 = auto)',
            type: 'number',
            defaultValue: 0,
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
        serverEnabled: {
            title: 'MJPEG server enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
            onPut: async (_oldValue, newValue) => {
                if (newValue) {
                    await this.discoverStreams();
                    await this.startStreaming();
                } else {
                    await this.stopStreaming();
                }
            },
        },
        discoverButton: {
            title: 'Refresh streams',
            type: 'button',
            onPut: async () => {
                await this.discoverStreams();
            },
        },
    });

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        plugin: MjpegRebroadcastPlugin,
    ) {
        super(options);
        this.plugin = plugin;
        const username = (plugin.storageSettings.values.username as string) || undefined;
        const password = (plugin.storageSettings.values.password as string) || undefined;
        this.mjpegServer = new MjpegServer(this.console, this.name, username, password);

        setTimeout(() => this.init(), 5000);
    }

    private async init() {
        if (this.killed) return;

        this.console.log(`MJPEG Rebroadcast mixin initialized for ${this.name}`);

        await this.discoverStreams();

        if (this.killed) return;

        if (this.storageSettings.values.serverEnabled) {
            await this.startStreaming();
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const mjpegSource = this.storageSettings.values.mjpegSource;

        // Hide width for snapshot mode
        this.storageSettings.settings.width.hide = mjpegSource === MjpegSourceEnum.ScryptedSnapshot;
        this.storageSettings.settings.quality.hide = mjpegSource === MjpegSourceEnum.ScryptedSnapshot;

        return this.storageSettings.getSettings();
    }

    async putMixinSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    /**
     * Discover all available RTSP rebroadcast streams for this camera.
     */
    private async discoverStreams() {
        this.discoveredStreams = [];

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
                this.discoveredStreams.push({
                    name: streamName,
                    rtspUrl,
                });
            }

            this.console.log(`${this.name}: found ${this.discoveredStreams.length} RTSP stream(s)`);
            for (const s of this.discoveredStreams) {
                this.console.log(`  - ${s.name}: ${s.rtspUrl}`);
            }
        } catch (e) {
            this.console.warn(`Failed to discover streams for ${this.name}: ${(e as Error).message}`);
        }
    }

    /**
     * Start the MJPEG server with all discovered streams.
     * For snapshot mode: one MJPEG endpoint polling the camera.
     * For RTSP mode: one FFmpeg process per RTSP stream, all served via the same HTTP server
     * with routes /stream/<name> for each stream.
     */
    private async startStreaming() {
        await this.stopStreaming();

        if (this.discoveredStreams.length === 0 && this.storageSettings.values.mjpegSource === MjpegSourceEnum.ScryptedRtspFfmpeg) {
            this.console.log(`No streams found for ${this.name}, trying to discover...`);
            await this.discoverStreams();
        }

        const port = (this.storageSettings.values.serverPort as number) || 0;
        const fps = (this.storageSettings.values.fps as number) || 5;
        const quality = (this.storageSettings.values.quality as number) || 80;
        const width = this.storageSettings.values.width as number;
        const mjpegSource = this.storageSettings.values.mjpegSource;

        try {
            const assignedPort = await this.mjpegServer.start(port);

            if (mjpegSource === MjpegSourceEnum.ScryptedSnapshot) {
                // Single snapshot polling producer
                const producer = new MjpegProducer(this.console);
                await producer.startSnapshotPolling(this.id, this.mjpegServer, fps);
                this.producers.set('snapshot', producer);

                this.console.log(`MJPEG snapshot stream for ${this.name} at http://localhost:${assignedPort}/stream`);
            } else if (mjpegSource === MjpegSourceEnum.ScryptedRtspFfmpeg) {
                if (this.discoveredStreams.length === 0) {
                    this.console.warn(`No RTSP streams found for ${this.name}. Make sure the Rebroadcast plugin is installed.`);
                    return;
                }

                // For simplicity, serve the first (main) stream on /stream
                // All streams are available as info on /status
                const mainStream = this.discoveredStreams[0];
                const producer = new MjpegProducer(this.console);
                await producer.startRtspToMjpeg(mainStream.rtspUrl, this.mjpegServer, fps, quality, width);
                this.producers.set(mainStream.name, producer);

                this.console.log(`MJPEG RTSP stream for ${this.name} (${mainStream.name}) at http://localhost:${assignedPort}/stream`);

                // Log all available streams
                this.console.log(`All RTSP streams for ${this.name}:`);
                for (const s of this.discoveredStreams) {
                    this.console.log(`  - ${s.name}: ${s.rtspUrl}`);
                }
            }
        } catch (e) {
            this.console.error(`Failed to start MJPEG streaming for ${this.name}`, (e as Error).message);
        }
    }

    private async stopStreaming() {
        for (const [name, producer] of this.producers) {
            producer.stop();
        }
        this.producers.clear();
        await this.mjpegServer.stop();
    }

    async release() {
        if (this.killed) return;
        this.killed = true;
        this.console.log(`Releasing MJPEG mixin for ${this.name}`);
        await this.stopStreaming();
        super.release();
    }
}
