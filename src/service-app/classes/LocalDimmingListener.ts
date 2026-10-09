import * as fs from 'node:fs';
import { fileOK } from '../../common/classes/Utils';
import { defaultLocalDimmingState, type LocalDimmingStateInterface } from '../../common/models/TccSettings';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class LocalDimmingListener {
    private static readonly platformBasePath: string = '/sys/devices/platform';
    private static readonly attrRelPath: string = 'mini_led_local_dimming/mini_led_local_dimming';
    private attrPath: string = undefined;
    private onStartRetryCount: number = 5;

    constructor(private tccd: TuxedoControlCenterDaemon) {
        this.init();
    }

    public onActiveProfileChanged(): void {}

    private async init(): Promise<void> {
        this.attrPath = this.findAttrPath();

        if (this.attrPath === undefined && this.onStartRetryCount) {
            console.log('LocalDimmingListener: Could not find local dimming control, retrying');
            --this.onStartRetryCount;
            setTimeout((): void => {
                this.init();
            }, 1000);
            return;
        }

        if (this.attrPath !== undefined) {
            console.log(`LocalDimmingListener: Detected local dimming control at ${this.attrPath}`);
            this.tccd.dbusData.localDimmingEnabledNewJSON.subscribe(
                this.localDimmingEnabledNewJSONSubscriptionHandler.bind(this),
            );
            await this.publishState();
            setInterval((): void => {
                this.publishState();
            }, 1000);
        } else {
            console.log('LocalDimmingListener: Detected no local dimming support');
            this.tccd.dbusData.localDimmingStateJSON = JSON.stringify(defaultLocalDimmingState);
        }
    }

    private findAttrPath(): string {
        try {
            for (const entry of fs.readdirSync(LocalDimmingListener.platformBasePath)) {
                const attrPath: string = `${LocalDimmingListener.platformBasePath}/${entry}/${LocalDimmingListener.attrRelPath}`;
                if (fileOK(attrPath)) {
                    return attrPath;
                }
            }
        } catch (err: unknown) {
            console.error(`LocalDimmingListener: findAttrPath failed => ${err}`);
        }
        return undefined;
    }

    private async publishState(): Promise<void> {
        const localDimmingState: LocalDimmingStateInterface = { supported: true, enabled: false };

        try {
            localDimmingState.enabled = (await fs.promises.readFile(this.attrPath)).toString().trim() === '1';
        } catch (err: unknown) {
            console.error(`LocalDimmingListener: publishState failed => ${err}`);
            return;
        }

        this.tccd.dbusData.localDimmingStateJSON = JSON.stringify(localDimmingState);
    }

    // Input from TCC
    private async localDimmingEnabledNewJSONSubscriptionHandler(localDimmingEnabled: boolean): Promise<void> {
        if (localDimmingEnabled === undefined) {
            return;
        }

        try {
            await fs.promises.writeFile(this.attrPath, localDimmingEnabled ? '1' : '0');
        } catch (err: unknown) {
            console.error(`LocalDimmingListener: setLocalDimmingEnabled failed => ${err}`);
        }

        await this.publishState();
    }
}
