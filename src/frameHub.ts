const BOUNDARY = 'mjpegboundary';

/**
 * Lightweight frame distribution hub for a single stream.
 * Producers push JPEG frames, consumers subscribe via AsyncGenerator.
 * Supports lifecycle callbacks for lazy start/stop of producers.
 */
export class FrameHub {
    private listeners: Set<(frame: Buffer) => void> = new Set();

    /** Called when subscriber count goes from 0 to 1. Awaited before streaming starts. */
    onFirstSubscriber: (() => Promise<void> | void) | null = null;
    /** Called when subscriber count goes from 1 to 0 */
    onLastUnsubscribe: (() => void) | null = null;

    push(frame: Buffer) {
        for (const listener of this.listeners) {
            listener(frame);
        }
    }

    get subscriberCount(): number {
        return this.listeners.size;
    }

    /**
     * Create an AsyncGenerator that yields MJPEG multipart chunks.
     * If this is the first subscriber, onFirstSubscriber is awaited before streaming.
     */
    async *subscribe(): AsyncGenerator<Buffer, void> {
        const queue: Buffer[] = [];
        let resolve: (() => void) | null = null;

        const listener = (frame: Buffer) => {
            const header = `\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
            const chunk = Buffer.concat([Buffer.from(header), frame]);
            queue.push(chunk);
            if (resolve) {
                resolve();
                resolve = null;
            }
        };

        const wasEmpty = this.listeners.size === 0;
        this.listeners.add(listener);

        // Start producer if this is the first subscriber — await it so FFmpeg has time to start
        if (wasEmpty && this.onFirstSubscriber) {
            await this.onFirstSubscriber();
        }

        try {
            while (true) {
                if (queue.length === 0) {
                    await new Promise<void>((r) => {
                        resolve = r;
                    });
                }
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
            }
        } finally {
            this.listeners.delete(listener);
            if (this.listeners.size === 0 && this.onLastUnsubscribe) {
                this.onLastUnsubscribe();
            }
        }
    }
}

export const MJPEG_BOUNDARY = BOUNDARY;
