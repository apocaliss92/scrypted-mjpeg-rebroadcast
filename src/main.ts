import sdk, {
    HttpRequest,
    HttpRequestHandler,
    HttpResponse,
    MixinProvider,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    Setting,
    Settings,
    SettingValue,
    WritableDeviceState,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { MjpegRebroadcastCameraMixin } from './cameraMixin';
import { MJPEG_BOUNDARY } from './frameHub';

const { endpointManager } = sdk;

export default class MjpegRebroadcastPlugin
    extends ScryptedDeviceBase
    implements Settings, MixinProvider, HttpRequestHandler
{
    currentMixinsMap: Record<string, MjpegRebroadcastCameraMixin> = {};
    private endpointUrlCache: string | null = null;

    storageSettings = new StorageSettings(this, {});

    constructor(nativeId: string) {
        super(nativeId);
        this.console.log('MJPEG Rebroadcast plugin loaded');
    }

    async getEndpointUrl(): Promise<string> {
        if (this.endpointUrlCache) return this.endpointUrlCache;

        let url = await endpointManager.getLocalEndpoint(undefined, {
            public: true,
            insecure: true,
        });
        url = url.replace(/\/+$/, '');
        this.endpointUrlCache = url;
        return url;
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if (
            (type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell) &&
            (interfaces.includes(ScryptedInterface.VideoCamera) || interfaces.includes(ScryptedInterface.Camera))
        ) {
            return [ScryptedInterface.Settings];
        }
        return undefined;
    }

    async getMixin(
        mixinDevice: any,
        mixinDeviceInterfaces: ScryptedInterface[],
        mixinDeviceState: WritableDeviceState,
    ): Promise<any> {
        // Mixin self-registers in its constructor via this.plugin.currentMixinsMap
        const mixin = new MjpegRebroadcastCameraMixin(
            {
                mixinDevice,
                mixinDeviceInterfaces,
                mixinDeviceState,
                mixinProviderNativeId: this.nativeId,
                group: 'MJPEG Rebroadcast',
                groupKey: 'mjpegRebroadcast',
            },
            this,
        );

        return mixin;
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        // Do NOT delete from currentMixinsMap here — Scrypted calls releaseMixin
        // for the OLD mixin AFTER getMixin has already stored the NEW one.
        // The new mixin constructor overwrites the map entry.
        try {
            await mixinDevice.release();
        } catch (e) {
            // this.console.warn(`Error releasing mixin ${id}: ${(e as Error).message}`);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const requestUrl = request.url || '';

        // Extract the token: everything after /public/
        const publicIdx = requestUrl.indexOf('/public/');
        const token = publicIdx !== -1 ? requestUrl.slice(publicIdx + '/public/'.length) : '';

        if (!token) {
            // Global status
            const streams: Record<string, { deviceName: string; streamName: string; subscribers: number }> = {};
            for (const mixin of Object.values(this.currentMixinsMap)) {
                if (mixin.killed) continue;
                for (const [tok] of mixin.frameHubs) {
                    streams[tok] = {
                        deviceName: mixin.name,
                        streamName: mixin.tokenToName.get(tok) ?? tok,
                        subscribers: mixin.frameHubs.get(tok)?.subscriberCount ?? 0,
                    };
                }
            }

            response.send(JSON.stringify({ streams }, null, 2), {
                code: 200,
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        // Find the hub by token across all active mixins
        for (const mixin of Object.values(this.currentMixinsMap)) {
            if (mixin.killed) continue;
            const hub = mixin.frameHubs.get(token);
            if (hub) {
                const generator = hub.subscribe();
                response.sendStream(generator, {
                    code: 200,
                    headers: {
                        'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'Connection': 'keep-alive',
                    },
                });
                return;
            }
        }

        response.send('Not found', { code: 404 });
    }
}
