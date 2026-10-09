import { Component, type OnInit } from '@angular/core';
import type { MatSliderThumb } from '@angular/material/slider';
import { interval, Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { GridParamsBacklight, type IGridParams } from '../../../common/models/IGridParams';
import {
    type KeyboardBacklightStateInterface,
    LightbarColorModes,
    type LightbarCapabilitiesInterface,
    type LightbarStateInterface,
} from '../../../common/models/TccSettings';
// biome-ignore lint: injection token
import { TccDBusClientService } from '../tcc-dbus-client.service';

@Component({
    selector: 'app-lightbar-control',
    templateUrl: './lightbar-control.component.html',
    styleUrls: ['./lightbar-control.component.scss'],
    standalone: false,
})
export class LightbarControlComponent implements OnInit {
    public lightbarCapabilities: LightbarCapabilitiesInterface;
    public lightbarState: LightbarStateInterface;
    public chosenBrightness: number;
    public chosenBrightnessPending: number = undefined;
    public chosenColorHex: string = '#ffffff';
    public chosenColorHexPending: string = undefined;
    public keyboardColorHex: string = undefined;
    public colorModes = LightbarColorModes;
    private pressTimer: NodeJS.Timeout;
    private pressInterval: Subscription;
    private colorPickerInUsage: boolean = false;
    private colorPickerTimeout: NodeJS.Timeout;
    private brightnessSliderInUsage: boolean = false;
    private brightnessSliderTimeout: number | null = null;
    private timeoutDuration: number = 1000;
    public gridParams: IGridParams = GridParamsBacklight;

    private lightbarCapabilitiesSubscription: Subscription = new Subscription();
    private lightbarStatesSubscription: Subscription = new Subscription();
    private keyboardBacklightStatesSubscription: Subscription = new Subscription();

    constructor(private tccdbus: TccDBusClientService) {}

    public ngOnInit(): void {
        this.subscribeLightbarCapabilities();
        this.subscribeLightbarStates();
        this.subscribeKeyboardBacklightStates();
    }

    public isSupported(): boolean {
        return this.lightbarCapabilities !== undefined && this.lightbarCapabilities.maxBrightness !== undefined;
    }

    // Converts integer value: 0xRRGGBBAA or 0xRRGGBB to a string value "#RRGGBB"
    private intToRGBSharpString(input: number): string {
        const hex: string = input.toString(16).padStart(input <= 0xffffff ? 6 : 8, '0');
        return `#${hex.substring(0, 6)}`;
    }

    // Converts a string value: "#RRGGBB" to an integer value: 0xRRGGBB
    private RGBSharpStringToInt(input: string): number {
        return Number.parseInt(input.replace('#', ''), 16);
    }

    private clamp(input: number, min: number, max: number): number {
        return Math.min(Math.max(input, min), max);
    }

    private subscribeLightbarCapabilities(): void {
        this.lightbarCapabilitiesSubscription.add(
            this.tccdbus.lightbarCapabilities
                .pipe(
                    filter((capabilities: LightbarCapabilitiesInterface): boolean => capabilities?.maxBrightness !== undefined),
                    take(1),
                )
                .subscribe((capabilities: LightbarCapabilitiesInterface): void =>
                    this.applyLightbarCapabilities(capabilities),
                ),
        );
    }

    private applyLightbarCapabilities(lightbarCapabilities: LightbarCapabilitiesInterface): void {
        this.lightbarCapabilities = lightbarCapabilities;
        this.chosenBrightness = this.clamp(
            this.chosenBrightness ?? Math.floor(lightbarCapabilities.maxBrightness * 0.5),
            0,
            lightbarCapabilities.maxBrightness,
        );
    }

    private subscribeLightbarStates(): void {
        this.lightbarStatesSubscription.add(
            this.tccdbus.lightbarStates.subscribe((lightbarState: LightbarStateInterface): void => {
                if (lightbarState === undefined) {
                    return;
                }
                this.lightbarState = lightbarState;

                if (this.isPickerInUsage()) {
                    this.chosenBrightnessPending = lightbarState.brightness;
                    this.chosenColorHexPending = this.intToRGBSharpString(
                        (lightbarState.red << 16) + (lightbarState.green << 8) + lightbarState.blue,
                    );
                } else {
                    this.chosenBrightness = lightbarState.brightness;
                    this.chosenColorHex = this.intToRGBSharpString(
                        (lightbarState.red << 16) + (lightbarState.green << 8) + lightbarState.blue,
                    );
                }
            }),
        );
    }

    private subscribeKeyboardBacklightStates(): void {
        this.keyboardBacklightStatesSubscription.add(
            this.tccdbus.keyboardBacklightStates.subscribe(
                (keyboardBacklightStates: KeyboardBacklightStateInterface[]): void => {
                    const keyboardState: KeyboardBacklightStateInterface = keyboardBacklightStates?.[0];
                    if (keyboardState?.red !== undefined && keyboardState?.green !== undefined && keyboardState?.blue !== undefined) {
                        this.keyboardColorHex = this.intToRGBSharpString(
                            (keyboardState.red << 16) + (keyboardState.green << 8) + keyboardState.blue,
                        );
                    }
                },
            ),
        );
    }

    public isColorModeKeyboard(): boolean {
        return this.lightbarState?.colorMode === LightbarColorModes.keyboard;
    }

    public getEffectiveColor(): string {
        return this.isColorModeKeyboard() ? (this.keyboardColorHex ?? this.chosenColorHex) : this.chosenColorHex;
    }

    private fillLightbarStateFromValues(brightness: number, colorHex: string): LightbarStateInterface {
        const rgbInt: number = this.RGBSharpStringToInt(colorHex);
        return {
            colorMode: this.lightbarState?.colorMode ?? LightbarColorModes.custom,
            brightness,
            red: (rgbInt >>> 16) & 0xff,
            green: (rgbInt >>> 8) & 0xff,
            blue: rgbInt & 0xff,
        };
    }

    public onBrightnessSliderInput(brightness: number): void {
        this.triggerBrightnessSliderTimeout();
        this.chosenBrightness = brightness;
        this.tccdbus.setLightbarStates(this.fillLightbarStateFromValues(brightness, this.chosenColorHex));
    }

    public onBrightnessSliderChange(): void {}

    public onColorPickerInput(color: string): void {
        this.triggerColorPickerTimeout();
        this.chosenColorHex = color;
        this.tccdbus.setLightbarStates(this.fillLightbarStateFromValues(this.chosenBrightness, color));
    }

    public onColorPickerDragStart(): void {
        this.triggerColorPickerTimeout();
    }

    public onColorPickerDragEnd(): void {
        this.triggerColorPickerTimeout();
    }

    public onColorModeChange(colorMode: LightbarColorModes): void {
        const state: LightbarStateInterface = this.fillLightbarStateFromValues(this.chosenBrightness, this.chosenColorHex);
        state.colorMode = colorMode;
        this.tccdbus.setLightbarStates(state);
    }

    private triggerBrightnessSliderTimeout(): void {
        if (this.brightnessSliderTimeout !== null) {
            clearTimeout(this.brightnessSliderTimeout);
        }
        this.brightnessSliderInUsage = true;
        this.brightnessSliderTimeout = window.setTimeout((): void => {
            this.brightnessSliderInUsage = false;
            this.applyPendingChanges();
        }, this.timeoutDuration);
    }

    private triggerColorPickerTimeout(): void {
        if (this.colorPickerTimeout) {
            clearTimeout(this.colorPickerTimeout);
        }
        this.colorPickerInUsage = true;
        this.colorPickerTimeout = setTimeout((): void => {
            this.colorPickerInUsage = false;
            this.applyPendingChanges();
        }, this.timeoutDuration);
    }

    private applyPendingChanges(): void {
        if (!this.isPickerInUsage()) {
            if (this.chosenBrightnessPending !== undefined) {
                this.chosenBrightness = this.chosenBrightnessPending;
                this.chosenBrightnessPending = undefined;
            }
            if (this.chosenColorHexPending !== undefined) {
                this.chosenColorHex = this.chosenColorHexPending;
                this.chosenColorHexPending = undefined;
            }
        }
    }

    public isPickerInUsage(): boolean {
        return this.colorPickerInUsage || this.brightnessSliderInUsage;
    }

    public startPress(slider: MatSliderThumb, offset: number, min: number, max: number): void {
        this.pressTimer = setTimeout((): void => {
            this.pressInterval = interval(200).subscribe((): void => {
                this.modifySliderInput(slider, offset, min, max);
            });
        }, 500);
        this.modifySliderInput(slider, offset, min, max);
    }

    public stopPress(): void {
        clearTimeout(this.pressTimer);
        if (this.pressInterval) {
            this.pressInterval.unsubscribe();
        }
    }

    public modifySliderInput(slider: MatSliderThumb, offset: number, min: number, max: number): void {
        let clampValue: number = +slider.value + offset;
        if (clampValue < min) {
            clampValue = min;
        } else if (clampValue > max) {
            clampValue = max;
        }

        this.onBrightnessSliderInput(clampValue);
    }

    public ngOnDestroy(): void {
        if (!this.lightbarCapabilitiesSubscription.closed) {
            this.lightbarCapabilitiesSubscription.unsubscribe();
        }

        if (!this.lightbarStatesSubscription.closed) {
            this.lightbarStatesSubscription.unsubscribe();
        }

        if (!this.keyboardBacklightStatesSubscription.closed) {
            this.keyboardBacklightStatesSubscription.unsubscribe();
        }
    }
}
