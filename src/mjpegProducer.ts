import sdk, { Camera, Image, MediaStreamDestination, ScryptedInterface, ScryptedMimeTypes, Settings, VideoCamera, VideoFrame, VideoFrameGenerator } from '@scrypted/sdk';

const { systemManager, mediaManager } = sdk;
const { spawn } = require('child_process');

const NVR_PLUGIN_ID = '@scrypted/nvr';
const VIDEO_ANALYSIS_PLUGIN_ID = '@scrypted/objectdetector';

export class MjpegProducer {
    private console: Console;
    private snapshotInterval: NodeJS.Timeout | null = null;
    private ffmpegProcess: any = null;
    private decoderAbort: (() => void) | null = null;
    private running = false;
    debugLog: (message: string, ...args: any[]) => void = () => {};
    onFrame: (frame: Buffer) => void = () => {};

    constructor(console: Console) {
        this.console = console;
    }

    async startSnapshotPolling(
        deviceId: string,
        fps: number = 2,
    ): Promise<void> {
        this.stop();
        this.running = true;

        const device = systemManager.getDeviceById(deviceId) as unknown as Camera;
        if (!device?.takePicture) {
            throw new Error(`Device ${deviceId} does not support Camera (snapshot) interface`);
        }

        const intervalMs = Math.max(100, Math.round(1000 / fps));
        this.debugLog(`Starting snapshot polling at ${fps} fps (${intervalMs}ms interval)`);

        const captureFrame = async () => {
            if (!this.running) return;

            try {
                const picture = await device.takePicture();
                const buffer = await mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');
                this.onFrame(Buffer.from(buffer));
            } catch (e) {
                this.console.warn(`Snapshot capture failed: ${(e as Error).message}`);
            }
        };

        await captureFrame();
        this.snapshotInterval = setInterval(captureFrame, intervalMs);
    }

    async startRtspToMjpeg(
        rtspUrl: string,
        fps: number = 5,
        quality: number = 80,
        width?: number,
    ): Promise<void> {
        this.stop();
        this.running = true;

        this.debugLog(`Starting RTSP→MJPEG conversion: ${rtspUrl}`);
        await this.startFfmpegMjpeg(rtspUrl, fps, quality, width);
    }

    private async startFfmpegMjpeg(
        inputUrl: string,
        fps: number,
        quality: number,
        width?: number,
    ): Promise<void> {
        const ffmpegPath = await this.getFfmpegPath();

        const args: string[] = [
            '-rtsp_transport', 'tcp',
            '-i', inputUrl,
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-r', fps.toString(),
            '-q:v', Math.max(1, Math.min(31, Math.round(31 - (quality / 100) * 30))).toString(),
        ];

        if (width) {
            args.push('-vf', `scale=${width}:-1`);
        }

        args.push('-');

        this.debugLog(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        this.ffmpegProcess = spawn(ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let jpegBuffer = Buffer.alloc(0);

        this.ffmpegProcess.stdout.on('data', (data: Buffer) => {
            jpegBuffer = Buffer.concat([jpegBuffer, data]);

            while (true) {
                const startIdx = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
                if (startIdx === -1) {
                    jpegBuffer = Buffer.alloc(0);
                    break;
                }

                const endIdx = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD9]), startIdx + 2);
                if (endIdx === -1) break;

                const frame = jpegBuffer.subarray(startIdx, endIdx + 2);
                this.onFrame(Buffer.from(frame));

                jpegBuffer = jpegBuffer.subarray(endIdx + 2);
            }
        });

        this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                this.debugLog(`FFmpeg: ${msg}`);
            }
        });

        this.ffmpegProcess.on('close', (code: number) => {
            this.console.log(`FFmpeg process exited with code ${code} (running=${this.running})`);
            this.ffmpegProcess = null;

            if (this.running && code !== 0) {
                this.console.warn('FFmpeg exited unexpectedly, restarting in 5 seconds...');
                setTimeout(() => {
                    if (this.running) {
                        this.startFfmpegMjpeg(inputUrl, fps, quality, width);
                    }
                }, 5000);
            }
        });

        this.ffmpegProcess.on('error', (err: Error) => {
            this.console.error('FFmpeg process error', err.message);
        });
    }

    async startDecoderStream(
        deviceId: string,
        streamDestination?: MediaStreamDestination,
    ): Promise<void> {
        this.stop();
        this.running = true;

        const device = systemManager.getDeviceById(deviceId) as unknown as VideoCamera;
        if (!device?.getVideoStream) {
            throw new Error(`Device ${deviceId} does not support VideoCamera interface`);
        }

        this.debugLog(`Starting Scrypted decoder stream for device ${deviceId} (destination: ${streamDestination ?? 'auto'})`);

        let aborted = false;
        this.decoderAbort = () => { aborted = true; };

        const runDecoder = async (skipDecoder: boolean) => {
            const stream = await device.getVideoStream({
                prebuffer: 0,
                destination: streamDestination,
                audio: null,
            });

            let frameGenerator: AsyncGenerator<VideoFrame, any, unknown>;

            if (!skipDecoder) {
                frameGenerator = stream as unknown as AsyncGenerator<VideoFrame, any, unknown>;
            } else {
                const videoFrameGenerator = this.findFrameGenerator();
                if (!videoFrameGenerator) {
                    throw new Error('No VideoFrameGenerator found (install NVR or Object Detection plugin)');
                }
                frameGenerator = await videoFrameGenerator.generateVideoFrames(stream, { queue: 0 });
            }

            for await (const frame of await sdk.connectRPCObject(frameGenerator)) {
                if (aborted || !this.running) break;

                try {
                    const convertedImage = await mediaManager.convertMediaObject<Image>(
                        frame.image,
                        ScryptedMimeTypes.Image,
                    );
                    const image = await convertedImage.toImage({ format: 'jpeg' });
                    const buffer = await image.toBuffer({ format: 'jpg' });
                    this.onFrame(Buffer.from(buffer));
                } catch (e) {
                    this.debugLog(`Decoder frame conversion failed: ${(e as Error).message}`);
                }
            }
        };

        // Run in background with fallback: try native decoder first, then VideoFrameGenerator
        (async () => {
            while (this.running && !aborted) {
                try {
                    await runDecoder(false);
                } catch (e) {
                    this.debugLog(`Native decoder failed, trying VideoFrameGenerator fallback: ${(e as Error).message}`);
                    try {
                        await runDecoder(true);
                    } catch (e2) {
                        this.console.error(`Decoder failed: ${(e2 as Error).message}`);
                    }
                }

                if (this.running && !aborted) {
                    this.console.warn('Decoder stream ended, restarting in 5 seconds...');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        })();
    }

    private findFrameGenerator(): VideoFrameGenerator | undefined {
        const webassembly = systemManager.getDeviceById(NVR_PLUGIN_ID, 'decoder') as unknown as VideoFrameGenerator;
        if (webassembly) return webassembly;

        const ffmpeg = systemManager.getDeviceById(VIDEO_ANALYSIS_PLUGIN_ID, 'ffmpeg') as unknown as VideoFrameGenerator;
        if (ffmpeg) return ffmpeg;

        // Search for any device implementing VideoFrameGenerator
        for (const id of Object.keys(systemManager.getSystemState())) {
            const d = systemManager.getDeviceById(id);
            if (d?.interfaces?.includes(ScryptedInterface.VideoFrameGenerator)) {
                return d as unknown as VideoFrameGenerator;
            }
        }

        return undefined;
    }

    private async getFfmpegPath(): Promise<string> {
        try {
            const ffmpegDevice = systemManager.getDeviceByName('FFmpeg');
            if (ffmpegDevice) {
                const settings = await (ffmpegDevice as unknown as Settings).getSettings();
                const pathSetting = settings.find(s => s.key === 'ffmpegPath');
                if (pathSetting?.value) return pathSetting.value as string;
            }
        } catch { /* ignore */ }

        return 'ffmpeg';
    }

    stop() {
        this.running = false;

        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
            this.snapshotInterval = null;
        }

        if (this.ffmpegProcess) {
            this.console.log('Sending SIGTERM to FFmpeg process');
            try {
                this.ffmpegProcess.kill('SIGTERM');
            } catch { /* ignore */ }
            this.ffmpegProcess = null;
        }

        if (this.decoderAbort) {
            this.decoderAbort();
            this.decoderAbort = null;
        }
    }

    get isRunning(): boolean {
        return this.running;
    }
}
