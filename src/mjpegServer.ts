import http from 'http';
import { MjpegClientInfo } from './types';

const BOUNDARY = '--mjpegboundary';

export class MjpegServer {
    private server: http.Server | null = null;
    private clients: Map<string, http.ServerResponse> = new Map();
    private clientInfos: Map<string, MjpegClientInfo> = new Map();
    private console: Console;
    private clientCounter = 0;
    private deviceName: string;
    private username?: string;
    private password?: string;

    constructor(console: Console, deviceName: string, username?: string, password?: string) {
        this.console = console;
        this.deviceName = deviceName;
        this.username = username;
        this.password = password;
    }

    async start(port: number): Promise<number> {
        if (this.server) {
            await this.stop();
        }

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                if (!this.checkAuth(req, res)) return;

                if (req.url === '/stream' || req.url === '/') {
                    this.handleMjpegRequest(req, res);
                } else if (req.url === '/status') {
                    this.handleStatusRequest(req, res);
                } else {
                    res.writeHead(404);
                    res.end('Not found');
                }
            });

            this.server.on('error', (err) => {
                this.console.error(`MJPEG server error for ${this.deviceName}`, err.message);
                reject(err);
            });

            this.server.listen(port, () => {
                const addr = this.server!.address() as any;
                const assignedPort = addr?.port ?? port;
                this.console.log(`MJPEG server for ${this.deviceName} listening on port ${assignedPort}`);
                resolve(assignedPort);
            });
        });
    }

    async stop(): Promise<void> {
        for (const [id, res] of this.clients) {
            try {
                res.end();
            } catch { /* ignore */ }
        }
        this.clients.clear();
        this.clientInfos.clear();

        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.console.log(`MJPEG server stopped for ${this.deviceName}`);
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        if (!this.username) return true;

        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Basic ')) {
            res.writeHead(401, { 'WWW-Authenticate': `Basic realm="MJPEG ${this.deviceName}"` });
            res.end('Unauthorized');
            return false;
        }

        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
        const [user, pass] = decoded.split(':');
        if (user === this.username && pass === (this.password ?? '')) {
            return true;
        }

        res.writeHead(401, { 'WWW-Authenticate': `Basic realm="MJPEG ${this.deviceName}"` });
        res.end('Unauthorized');
        return false;
    }

    private handleMjpegRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const clientId = `client-${++this.clientCounter}`;

        res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Connection': 'keep-alive',
        });

        this.clients.set(clientId, res);
        this.clientInfos.set(clientId, {
            id: clientId,
            connectedAt: new Date(),
            framesSent: 0,
        });

        this.console.log(`MJPEG client connected: ${clientId} (${req.socket.remoteAddress})`);

        req.on('close', () => {
            this.clients.delete(clientId);
            this.clientInfos.delete(clientId);
            this.console.log(`MJPEG client disconnected: ${clientId}`);
        });
    }

    private handleStatusRequest(_req: http.IncomingMessage, res: http.ServerResponse) {
        const status = {
            device: this.deviceName,
            clients: this.clients.size,
            clientDetails: Array.from(this.clientInfos.values()).map(c => ({
                id: c.id,
                connectedAt: c.connectedAt.toISOString(),
                framesSent: c.framesSent,
            })),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
    }

    pushFrame(jpegBuffer: Buffer) {
        const header = `\r\n${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`;

        for (const [clientId, res] of this.clients) {
            try {
                res.write(header);
                res.write(jpegBuffer);

                const info = this.clientInfos.get(clientId);
                if (info) {
                    info.framesSent++;
                }
            } catch (e) {
                this.console.warn(`Failed to send frame to ${clientId}, removing client`);
                this.clients.delete(clientId);
                this.clientInfos.delete(clientId);
            }
        }
    }

    get connectedClients(): number {
        return this.clients.size;
    }

    get isRunning(): boolean {
        return this.server !== null;
    }
}
