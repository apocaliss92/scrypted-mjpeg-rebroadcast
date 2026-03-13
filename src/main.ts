import sdk, {
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

export default class MjpegRebroadcastPlugin
    extends ScryptedDeviceBase
    implements Settings, MixinProvider
{
    currentMixinsMap: Record<string, MjpegRebroadcastCameraMixin> = {};

    storageSettings = new StorageSettings(this, {
        username: {
            title: 'Username',
            description: 'Username for HTTP Basic auth (leave empty to disable auth)',
            type: 'string',
            group: 'Authentication',
        },
        password: {
            title: 'Password',
            description: 'Password for HTTP Basic auth',
            type: 'password',
            group: 'Authentication',
        },
    });

    constructor(nativeId: string) {
        super(nativeId);
        this.console.log('MJPEG Rebroadcast plugin loaded');
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
        return [];
    }

    async getMixin(
        mixinDevice: any,
        mixinDeviceInterfaces: ScryptedInterface[],
        mixinDeviceState: WritableDeviceState,
    ): Promise<any> {
        const existing = this.currentMixinsMap[mixinDeviceState.id];
        if (existing) {
            this.console.log(`Releasing previous mixin for ${mixinDeviceState.name} before creating new one`);
            try {
                await existing.release();
            } catch (e) {
                this.console.warn(`Error releasing previous mixin: ${(e as Error).message}`);
            }
        }

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

        this.currentMixinsMap[mixinDeviceState.id] = mixin;
        return mixin;
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        delete this.currentMixinsMap[id];
        try {
            await mixinDevice.release();
        } catch (e) {
            this.console.warn(`Error releasing mixin ${id}: ${(e as Error).message}`);
        }
    }
}
