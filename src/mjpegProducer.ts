import sdk, { Camera, Settings } from '@scrypted/sdk';
import { MjpegServer } from './mjpegServer';

const { systemManager, mediaManager } = sdk;
const { spawn } = require('child_process');

export class MjpegProducer {
    private console: Console;
    private snapshotInterval: NodeJS.Timeout | null = null;
    private ffmpegProcess: any = null;
    private running = false;

    constructor(console: Console) {
        this.console = console;
    }

    /**
     * Start producing MJPEG frames via snapshot polling from the camera device.
     */
    async startSnapshotPolling(
        deviceId: string,
        server: MjpegServer,
        fps: number = 2,
    ): Promise<void> {
        this.stop();
        this.running = true;

        const device = systemManager.getDeviceById(deviceId) as unknown as Camera;
        if (!device?.takePicture) {
            throw new Error(`Device ${deviceId} does not support Camera (snapshot) interface`);
        }

        const intervalMs = Math.max(100, Math.round(1000 / fps));
        this.console.log(`Starting snapshot polling at ${fps} fps (${intervalMs}ms interval)`);

        const captureFrame = async () => {
            if (!this.running) return;

            try {
                const picture = await device.takePicture();
                const buffer = await mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');
                server.pushFrame(Buffer.from(buffer));
            } catch (e) {
                this.console.warn(`Snapshot capture failed: ${(e as Error).message}`);
            }
        };

        await captureFrame();
        this.snapshotInterval = setInterval(captureFrame, intervalMs);
    }

    /**
     * Start producing MJPEG frames from an RTSP stream via FFmpeg.
     */
    async startRtspToMjpeg(
        rtspUrl: string,
        server: MjpegServer,
        fps: number = 5,
        quality: number = 80,
        width?: number,
    ): Promise<void> {
        this.stop();
        this.running = true;

        this.console.log(`Starting RTSP→MJPEG conversion: ${rtspUrl}`);
        await this.startFfmpegMjpeg(rtspUrl, server, fps, quality, width);
    }

    private async startFfmpegMjpeg(
        inputUrl: string,
        server: MjpegServer,
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

        this.console.log(`FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

        this.ffmpegProcess = spawn(ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let jpegBuffer = Buffer.alloc(0);

        this.ffmpegProcess.stdout.on('data', (data: Buffer) => {
            jpegBuffer = Buffer.concat([jpegBuffer, data]);

            // JPEG files start with 0xFFD8 and end with 0xFFD9
            while (true) {
                const startIdx = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
                if (startIdx === -1) {
                    jpegBuffer = Buffer.alloc(0);
                    break;
                }

                const endIdx = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD9]), startIdx + 2);
                if (endIdx === -1) break;

                const frame = jpegBuffer.subarray(startIdx, endIdx + 2);
                server.pushFrame(Buffer.from(frame));

                jpegBuffer = jpegBuffer.subarray(endIdx + 2);
            }
        });

        this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                this.console.debug(`FFmpeg: ${msg}`);
            }
        });

        this.ffmpegProcess.on('close', (code: number) => {
            this.console.log(`FFmpeg process exited with code ${code}`);
            this.ffmpegProcess = null;

            if (this.running && code !== 0) {
                this.console.log('FFmpeg exited unexpectedly, restarting in 5 seconds...');
                setTimeout(() => {
                    if (this.running) {
                        this.startFfmpegMjpeg(inputUrl, server, fps, quality, width);
                    }
                }, 5000);
            }
        });

        this.ffmpegProcess.on('error', (err: Error) => {
            this.console.error('FFmpeg process error', err.message);
        });
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
            try {
                this.ffmpegProcess.kill('SIGTERM');
            } catch { /* ignore */ }
            this.ffmpegProcess = null;
        }
    }

    get isRunning(): boolean {
        return this.running;
    }
}
