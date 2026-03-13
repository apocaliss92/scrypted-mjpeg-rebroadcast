export interface MjpegClientInfo {
    id: string;
    connectedAt: Date;
    framesSent: number;
}

export enum MjpegSourceEnum {
    ScryptedSnapshot = 'Scrypted Snapshot (polling)',
    ScryptedRtspFfmpeg = 'Scrypted RTSP via FFmpeg',
}
