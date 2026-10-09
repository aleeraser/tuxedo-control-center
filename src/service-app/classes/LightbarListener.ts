import * as fs from 'node:fs';
import { fileOK, fileOKAsync } from '../../common/classes/Utils';
import {
    LightbarColorModes,
    type LightbarCapabilitiesInterface,
    type LightbarStateInterface,
} from '../../common/models/TccSettings';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class LightbarListener {
    protected lightbarPaths: Array<string> = ['/sys/class/leds/rgb:lightbar'];
    protected lightbarPath: string = undefined;
    protected lightbarCapabilities: LightbarCapabilitiesInterface = undefined;
    protected onStartRetryCount: number = 5;

    constructor(private tccd: TuxedoControlCenterDaemon) {
        this.init();
    }

    public onActiveProfileChanged(): void {}

    private async init(): Promise<void> {
        this.updateLightbarCapabilities();

        if (this.lightbarPath === undefined && this.onStartRetryCount) {
            console.log('LightbarListener: Could not find lightbar, retrying');
            --this.onStartRetryCount;
            setTimeout((): void => {
                this.init();
            }, 1000);
            return;
        }

        if (this.lightbarPath !== undefined) {
            // Init state in settings from current hardware state if not yet done
            if (this.tccd.settings.lightbarState === undefined) {
                this.tccd.settings.lightbarState = await this.readLightbarStateFromSysFS();
                this.tccd.config.writeSettingsAsync(this.tccd.settings);
            }

            this.tccd.dbusData.lightbarCapabilitiesJSON = JSON.stringify(this.lightbarCapabilities);
            this.tccd.dbusData.lightbarStatesJSON = JSON.stringify(this.tccd.settings.lightbarState);
            this.tccd.dbusData.lightbarStatesNewJSON.subscribe(
                this.lightbarStatesNewJSONSubscriptionHandler.bind(this),
            );
            this.tccd.dbusData.keyboardBacklightStatesJSONSubject.subscribe(
                this.keyboardBacklightStatesSubscriptionHandler.bind(this),
            );

            await this.initSysFSListener();
        } else {
            console.log('LightbarListener: Detected no lightbar');
            this.tccd.dbusData.lightbarCapabilitiesJSON = '{}';
        }
    }

    // Input from SysFS
    private async initSysFSListener(): Promise<void> {
        if (await fileOKAsync(`${this.lightbarPath}/brightness`)) {
            fs.watch(
                `${this.lightbarPath}/brightness`,
                async function (): Promise<void> {
                    const brightness: number = Number((await fs.promises.readFile(`${this.lightbarPath}/brightness`))
                        .toString()
                        .trim());
                    const lightbarStateNew: LightbarStateInterface = this.getState();
                    if (lightbarStateNew && !Number.isNaN(brightness)) {
                        lightbarStateNew.brightness = brightness;
                        this.setLightbarStates(lightbarStateNew, false, true, true);
                    }
                }.bind(this),
            );
        }

        if (await fileOKAsync(`${this.lightbarPath}/multi_intensity`)) {
            fs.watch(
                `${this.lightbarPath}/multi_intensity`,
                async function (): Promise<void> {
                    // While matching the keyboard color the keyboard is the source of truth
                    if (this.getState()?.colorMode !== LightbarColorModes.custom) {
                        return;
                    }
                    const colors: number[] = (await fs.promises.readFile(`${this.lightbarPath}/multi_intensity`))
                        .toString()
                        .split(' ')
                        .map(Number);
                    const lightbarStateNew: LightbarStateInterface = this.getState();
                    if (lightbarStateNew && colors?.length >= 3) {
                        lightbarStateNew.red = colors[0];
                        lightbarStateNew.green = colors[1];
                        lightbarStateNew.blue = colors[2];
                        this.setLightbarStates(lightbarStateNew, false, true, true);
                    }
                }.bind(this),
            );
        }
    }

    // Input from TCC
    private lightbarStatesPendingNewJSON: string = undefined;
    private lightbarStatesWritingNew: boolean = false;
    private async lightbarStatesNewJSONSubscriptionHandler(lightbarStatesNewJSON: string): Promise<void> {
        if (lightbarStatesNewJSON !== undefined) {
            this.lightbarStatesPendingNewJSON = lightbarStatesNewJSON;

            if (this.lightbarStatesWritingNew === false) {
                this.lightbarStatesWritingNew = true;
                while (this.lightbarStatesPendingNewJSON !== undefined) {
                    const lightbarStatesNew: LightbarStateInterface = JSON.parse(this.lightbarStatesPendingNewJSON);
                    this.lightbarStatesPendingNewJSON = undefined;
                    await this.setLightbarStates(lightbarStatesNew, true, true, false);
                }
                this.lightbarStatesWritingNew = false;
            }
        }
    }

    // Input from keyboard backlight: mirror keyboard color onto the lightbar
    private async keyboardBacklightStatesSubscriptionHandler(keyboardBacklightStatesJSON: string): Promise<void> {
        if (this.lightbarPath === undefined || keyboardBacklightStatesJSON === undefined) {
            return;
        }
        if (this.getState()?.colorMode !== LightbarColorModes.keyboard) {
            return;
        }
        const color: { red: number; green: number; blue: number } = this.getKeyboardColor();
        if (color && (await fileOKAsync(`${this.lightbarPath}/multi_intensity`))) {
            await fs.promises.appendFile(
                `${this.lightbarPath}/multi_intensity`,
                `${color.red} ${color.green} ${color.blue}`,
            );
        }
    }

    // Utility
    private updateLightbarCapabilities(): void {
        this.lightbarPath = undefined;
        this.lightbarCapabilities = undefined;

        for (const lightbarPath of this.lightbarPaths) {
            if (fileOK(`${lightbarPath}/max_brightness`) && fileOK(`${lightbarPath}/multi_intensity`)) {
                this.lightbarPath = lightbarPath;
                break;
            }
        }

        if (this.lightbarPath === undefined) {
            return;
        }

        console.log(`LightbarListener: Detected lightbar at ${this.lightbarPath}`);
        this.lightbarCapabilities = {
            maxBrightness: Number(fs.readFileSync(`${this.lightbarPath}/max_brightness`)),
            maxRed: 0xff,
            maxGreen: 0xff,
            maxBlue: 0xff,
        };

        if (fileOK(`${this.lightbarPath}/multi_max_intensity`)) {
            const maxColors: number[] = fs
                .readFileSync(`${this.lightbarPath}/multi_max_intensity`)
                .toString()
                .split(' ')
                .map(Number);
            if (maxColors?.length >= 3) {
                this.lightbarCapabilities.maxRed = maxColors[0];
                this.lightbarCapabilities.maxGreen = maxColors[1];
                this.lightbarCapabilities.maxBlue = maxColors[2];
            }
        }
    }

    private getState(): LightbarStateInterface {
        return this.tccd.settings.lightbarState;
    }

    private getKeyboardColor(): { red: number; green: number; blue: number } {
        const keyboardState = this.tccd.settings.keyboardBacklightStates?.[0];
        if (
            keyboardState &&
            keyboardState.red !== undefined &&
            keyboardState.green !== undefined &&
            keyboardState.blue !== undefined
        ) {
            return { red: keyboardState.red, green: keyboardState.green, blue: keyboardState.blue };
        }
        return undefined;
    }

    private async readLightbarStateFromSysFS(): Promise<LightbarStateInterface> {
        const lightbarState: LightbarStateInterface = {
            colorMode: LightbarColorModes.custom,
            brightness: 0,
            red: 255,
            green: 255,
            blue: 255,
        };

        try {
            lightbarState.brightness = Number((await fs.promises.readFile(`${this.lightbarPath}/brightness`)).toString().trim());
            const colors: number[] = (await fs.promises.readFile(`${this.lightbarPath}/multi_intensity`))
                .toString()
                .split(' ')
                .map(Number);
            if (colors?.length >= 3) {
                lightbarState.red = colors[0];
                lightbarState.green = colors[1];
                lightbarState.blue = colors[2];
            }
        } catch (err: unknown) {
            console.error(`LightbarListener: readLightbarStateFromSysFS failed => ${err}`);
        }

        return lightbarState;
    }

    protected async setLightbarStates(
        lightbarStatesNew: LightbarStateInterface,
        updateSysFS: boolean = true,
        updateSettings: boolean = true,
        updateTCC: boolean = true,
    ): Promise<void> {
        if (lightbarStatesNew === undefined) {
            return;
        }

        if (updateSysFS) {
            try {
                if (await fileOKAsync(`${this.lightbarPath}/brightness`)) {
                    await fs.promises.writeFile(`${this.lightbarPath}/brightness`, lightbarStatesNew.brightness.toString());
                }

                const color: { red: number; green: number; blue: number } =
                    lightbarStatesNew.colorMode === LightbarColorModes.keyboard
                        ? this.getKeyboardColor()
                        : {
                              red: lightbarStatesNew.red,
                              green: lightbarStatesNew.green,
                              blue: lightbarStatesNew.blue,
                          };

                if (color && (await fileOKAsync(`${this.lightbarPath}/multi_intensity`))) {
                    await fs.promises.appendFile(
                        `${this.lightbarPath}/multi_intensity`,
                        `${color.red} ${color.green} ${color.blue}`,
                    );
                }
            } catch (err: unknown) {
                console.error(`LightbarListener: setLightbarStates failed => ${err}`);
            }
        }

        if (updateSettings) {
            this.tccd.settings.lightbarState = lightbarStatesNew;
            await this.tccd.config.writeSettingsAsync(this.tccd.settings);
        }

        if (updateTCC) {
            this.tccd.dbusData.lightbarStatesJSON = JSON.stringify(lightbarStatesNew);
        }
    }
}
