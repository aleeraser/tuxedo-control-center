/*!
 * Copyright (c) 2019-2026 TUXEDO Computers GmbH <tux@tuxedocomputers.com>
 *
 * This file is part of TUXEDO Control Center.
 *
 * TUXEDO Control Center is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TUXEDO Control Center is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with TUXEDO Control Center.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Component, type OnInit } from '@angular/core';
import type { MatSliderThumb } from '@angular/material/slider';
import { interval, Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { GridParamsBacklight, type IGridParams } from '../../../common/models/IGridParams';
import {
    type KeyboardBacklightCapabilitiesInterface,
    KeyboardBacklightColorModes,
    type KeyboardBacklightKeyMapInterface,
    type KeyboardBacklightStateInterface,
} from '../../../common/models/TccSettings';
// biome-ignore lint: injection token
import { ConfigService } from '../config.service';
// biome-ignore lint: injection token
import { TccDBusClientService } from '../tcc-dbus-client.service';

@Component({
    selector: 'app-keyboard-backlight',
    templateUrl: './keyboard-backlight.component.html',
    styleUrls: ['./keyboard-backlight.component.scss'],
    standalone: false,
})
export class KeyboardBacklightComponent implements OnInit {
    public keyboardBacklightCapabilities: KeyboardBacklightCapabilitiesInterface;
    public chosenBrightness: number;
    public chosenBrightnessPending: number = undefined;
    public chosenColorHex: Array<string>;
    public chosenColorHexPending: Array<string> = undefined;
    public selectedZones: Array<number>;
    private pressTimer: NodeJS.Timeout;
    private pressInterval: Subscription;
    private colorPickerInUsage: Array<boolean> = [];
    private colorPickerTimeout: NodeJS.Timeout;
    private brightnessSliderInUsage: boolean;
    private brightnessSliderTimeout: number | null = null;
    private timeoutDuration: number = 1000;
    public gridParams: IGridParams = GridParamsBacklight;

    // Per-key (zones > 4) press-to-select + calibration
    public keyMap: KeyboardBacklightKeyMapInterface = {};
    public pressMode: boolean = false;
    public calibration: { keycode: number; candidates: number[]; pos: number } = undefined;
    public currentColor: string = '#ffffff';
    private pressPollTimer: number = undefined;

    private keyboardBacklightKeyMapSubscription: Subscription = new Subscription();
    private keyboardBacklightCapabilitiesSubscription: Subscription = new Subscription();
    private keyboardBacklightStatesSubscription: Subscription = new Subscription();

    constructor(
        public config: ConfigService,
        private tccdbus: TccDBusClientService,
    ) {}

    public ngOnInit(): void {
        this.subscribeKeyboardBacklightCapabilities();
        this.subscribeKeyboardBacklightStates();
        this.subscribeKeyboardBacklightKeyMap();
        this.setColorPickerInUsageDefault();
    }

    // Converts integer value: 0xRRGGBBAA or 0xRRGGBB to a string value "#RRGGBB"
    private intToRGBSharpString(input: number): string {
        const hex: string = input.toString(16).padStart(input <= 0xffffff ? 6 : 8, '0');
        return `#${hex.substring(0, 6)}`;
    }

    // Converts a string value: "#RRGGBB" to an integer value: 0xRRGGBBAA
    private RGBSharpStringToInt(input: string, alpha = '00'): number {
        const hex: string = input.replace('#', '') + alpha;
        return Number.parseInt(hex, 16);
    }

    private clamp(input: number, min: number, max: number): number {
        return Math.min(Math.max(input, min), max);
    }

    private setColorPickerInUsageDefault(): void {
        const zones: number = this.keyboardBacklightCapabilities.zones;
        for (let i: number = 0; i < zones; i++) {
            this.colorPickerInUsage.push(false);
        }
    }

    private subscribeKeyboardBacklightCapabilities(): void {
        this.keyboardBacklightCapabilitiesSubscription.add(
            this.tccdbus.keyboardBacklightCapabilities
                .pipe(filter(Boolean), take(1))
                .subscribe((capabilities: KeyboardBacklightCapabilitiesInterface): void =>
                    this.applyBacklightCapabilities(capabilities),
                ),
        );
    }

    private applyBacklightCapabilities(keyboardBacklightCapabilities: KeyboardBacklightCapabilitiesInterface): void {
        const { maxBrightness, zones } = keyboardBacklightCapabilities;

        this.keyboardBacklightCapabilities = keyboardBacklightCapabilities;
        this.chosenBrightness = this.clamp(this.chosenBrightness || Math.floor(maxBrightness * 0.5), 0, maxBrightness);

        const validColors: string[] = this.chosenColorHex?.slice(0, zones) ?? [];
        const defaultColors: string[] = Array.from({ length: zones - validColors?.length }, (): string => '#ffffff');
        this.chosenColorHex = [...validColors, ...defaultColors].map((color: string): string => color ?? '#ffffff');

        if (zones > 4) {
            this.selectedZones = [];
        }
    }

    public isPerKey(): boolean {
        return this.keyboardBacklightCapabilities?.zones > 4;
    }

    private setKeyboardBacklightStates(
        keyboardBacklightStates: KeyboardBacklightStateInterface[],
        hasChosenColor: boolean,
        hasNoPickerInUsage: boolean,
    ): void {
        if (keyboardBacklightStates?.[0]) {
            const { brightness } = keyboardBacklightStates[0];

            if (hasChosenColor && hasNoPickerInUsage) {
                this.chosenBrightness = brightness;
                this.chosenColorHex = this.createColorHexArray(keyboardBacklightStates);
            } else {
                this.chosenBrightnessPending = brightness;
                this.chosenColorHexPending = this.createColorHexArray(keyboardBacklightStates);
            }
        }
    }

    private subscribeKeyboardBacklightStates(): void {
        this.keyboardBacklightStatesSubscription.add(
            this.tccdbus.keyboardBacklightStates.subscribe(
                (keyboardBacklightStates: KeyboardBacklightStateInterface[]): void => {
                    const hasChosenColor: boolean = keyboardBacklightStates?.length > 0;
                    const hasNoPickerInUsage: boolean = !this.isPickerInUsage();
                    this.setKeyboardBacklightStates(keyboardBacklightStates, hasChosenColor, hasNoPickerInUsage);
                },
            ),
        );
    }

    private createColorHexArray(keyboardBacklightStates: KeyboardBacklightStateInterface[]): string[] {
        return keyboardBacklightStates
            .map(({ red, green, blue }: KeyboardBacklightStateInterface): number => {
                if (red !== undefined && green !== undefined && blue !== undefined) {
                    return (red << 16) + (green << 8) + blue;
                }
                return (255 << 16) + (255 << 8) + 255;
            })
            .map(this.intToRGBSharpString);
    }

    public isPickerInUsage(): boolean {
        return this.colorPickerInUsage.some((inUse: boolean): boolean => inUse) || this.brightnessSliderInUsage;
    }

    private fillKeyboardBacklightStatesFromValues(
        brightness: number,
        colorHex: string[] = [],
    ): KeyboardBacklightStateInterface[] {
        return colorHex
            ? colorHex.map((hex: string): KeyboardBacklightStateInterface => {
                  const rgbaInt: number = this.RGBSharpStringToInt(hex);
                  return {
                      mode: KeyboardBacklightColorModes.static,
                      brightness,
                      red: (rgbaInt >>> 24) & 0xff,
                      green: (rgbaInt >>> 16) & 0xff,
                      blue: (rgbaInt >>> 8) & 0xff,
                  };
              })
            : [
                  {
                      mode: KeyboardBacklightColorModes.static,
                      brightness,
                      red: undefined,
                      green: undefined,
                      blue: undefined,
                  },
              ];
    }

    public onBrightnessSliderInput(brightness: number): void {
        this.triggerBrightnessSliderTimeout();
        const colorHex: string[] = this.chosenColorHex?.length ? this.chosenColorHex : undefined;

        this.chosenBrightness = brightness;
        this.tccdbus.setKeyboardBacklightStates(this.fillKeyboardBacklightStatesFromValues(brightness, colorHex));
    }

    public onBrightnessSliderChange(): void {}

    public onColorPickerInput(color: string, selectedZones: number[]): void {
        this.triggerColorPickerTimeout(selectedZones);

        this.currentColor = color;
        const colorHex: string[] = this.chosenColorHex;
        for (const zone of selectedZones) {
            colorHex[zone] = color;
        }

        const backlightStates: KeyboardBacklightStateInterface[] = this.fillKeyboardBacklightStatesFromValues(
            this.chosenBrightness,
            colorHex,
        );
        this.tccdbus.setKeyboardBacklightStates(backlightStates);
    }

    public onColorPickerDragStart(selectedZones: number[]): void {
        this.triggerColorPickerTimeout(selectedZones);
    }

    public onColorPickerDragEnd(selectedZones: number[]): void {
        this.triggerColorPickerTimeout(selectedZones);
    }

    public selectedZonesChange(selectedZones: number[]): void {
        if (this.isPerKey()) {
            // Per-key selection is driven by press-to-select, not the SVG zone click.
            return;
        }
        this.selectedZones = selectedZones;
    }

    private subscribeKeyboardBacklightKeyMap(): void {
        this.keyboardBacklightKeyMapSubscription.add(
            this.tccdbus.keyboardBacklightKeyMap.subscribe((keyMap: KeyboardBacklightKeyMapInterface): void => {
                if (keyMap) {
                    this.keyMap = keyMap;
                }
            }),
        );
    }

    public togglePressMode(): void {
        this.pressMode = !this.pressMode;
        if (this.pressMode) {
            this.startPressPolling();
        } else {
            this.stopPressPolling();
            this.stopCalibration();
        }
    }

    private startPressPolling(): void {
        this.stopPressPolling();
        this.pressPollTimer = window.setInterval((): void => {
            this.pollPressedKey();
        }, 250);
    }

    private stopPressPolling(): void {
        if (this.pressPollTimer !== undefined) {
            clearInterval(this.pressPollTimer);
            this.pressPollTimer = undefined;
        }
    }

    private async pollPressedKey(): Promise<void> {
        const keycode: number = await this.tccdbus.consumeKeyboardBacklightKeyPressed();
        if (keycode === undefined) {
            return;
        }
        this.handlePressedKey(keycode);
    }

    private handlePressedKey(keycode: number): void {
        const mapped: number = this.keyMap?.[keycode];
        if (mapped !== undefined) {
            this.selectedZones = [mapped];
            this.currentColor = this.chosenColorHex?.[mapped] ?? this.currentColor;
            return;
        }
        this.startCalibration(keycode);
    }

    private startCalibration(keycode: number): void {
        const zones: number = this.keyboardBacklightCapabilities.zones;
        const mappedIndices: Set<number> = new Set<number>(Object.values(this.keyMap ?? {}));
        const candidates: number[] = [];
        for (let i: number = 0; i < zones; ++i) {
            if (!mappedIndices.has(i)) {
                candidates.push(i);
            }
        }
        if (candidates.length === 0) {
            return;
        }
        this.calibration = { keycode, candidates, pos: 0 };
        this.highlightCalibrationCandidate();
    }

    private highlightCalibrationCandidate(): void {
        if (!this.calibration) {
            return;
        }
        this.tccdbus.highlightKeyboardBacklightLed(this.calibration.candidates[this.calibration.pos], true);
    }

    // Manual stepping: advance to the next candidate only when the user clicks "Next".
    public advanceCalibration(): void {
        if (!this.calibration) {
            return;
        }
        this.tccdbus.highlightKeyboardBacklightLed(this.calibration.candidates[this.calibration.pos], false);
        this.calibration.pos += 1;
        if (this.calibration.pos >= this.calibration.candidates.length) {
            this.calibration.pos = 0;
        }
        this.highlightCalibrationCandidate();
    }

    public confirmCalibration(): void {
        if (!this.calibration) {
            return;
        }
        const ledIndex: number = this.calibration.candidates[this.calibration.pos];
        this.tccdbus.highlightKeyboardBacklightLed(ledIndex, false);
        this.tccdbus.setKeyboardBacklightKeyMapEntry(this.calibration.keycode, ledIndex);
        this.keyMap = { ...this.keyMap, [this.calibration.keycode]: ledIndex };
        this.selectedZones = [ledIndex];
        this.currentColor = this.chosenColorHex?.[ledIndex] ?? this.currentColor;
        this.stopCalibration();
    }

    public cancelCalibration(): void {
        this.stopCalibration();
    }

    private stopCalibration(): void {
        if (this.calibration) {
            this.tccdbus.highlightKeyboardBacklightLed(this.calibration.candidates[this.calibration.pos], false);
        }
        this.calibration = undefined;
    }

    private invertKeyMap(ledIndex: number): number | undefined {
        for (const key of Object.keys(this.keyMap ?? {})) {
            if (this.keyMap[Number(key)] === ledIndex) {
                return Number(key);
            }
        }
        return undefined;
    }

    public hasSelectedMapping(): boolean {
        if (!this.selectedZones?.length) {
            return false;
        }
        return this.invertKeyMap(this.selectedZones[0]) !== undefined;
    }

    // Fix a wrongly mapped key: clear its mapping and re-run calibration for it.
    public reassignSelectedKey(): void {
        if (!this.selectedZones?.length) {
            return;
        }
        const ledIndex: number = this.selectedZones[0];
        const keycode: number = this.invertKeyMap(ledIndex);
        if (keycode === undefined) {
            return;
        }
        this.tccdbus.setKeyboardBacklightKeyMapEntry(keycode, -1);
        const updated: KeyboardBacklightKeyMapInterface = { ...this.keyMap };
        delete updated[keycode];
        this.keyMap = updated;
        this.startCalibration(keycode);
    }

    public fillAllKeys(color: string): void {
        const zones: number = this.keyboardBacklightCapabilities.zones;
        const colorHex: string[] = Array.from({ length: zones }, (): string => color);
        this.chosenColorHex = colorHex;
        this.tccdbus.setKeyboardBacklightStates(
            this.fillKeyboardBacklightStatesFromValues(this.chosenBrightness, colorHex),
        );
    }

    public clearAllKeys(): void {
        this.fillAllKeys('#000000');
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

    private triggerColorPickerTimeout(selectedZones: number[]): void {
        if (this.colorPickerTimeout) {
            clearTimeout(this.colorPickerTimeout);
        }
        selectedZones.forEach((zone: number): void => {
            this.colorPickerInUsage[zone] = true;
        });

        this.colorPickerTimeout = setTimeout((): void => {
            selectedZones.forEach((zone: number): void => {
                this.colorPickerInUsage[zone] = false;
            });
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

    public getSelectedColor(): string {
        if (this.selectedZones?.length) {
            return this.chosenColorHex[this.selectedZones[0]] ?? this.currentColor;
        }
        return this.currentColor;
    }

    public hasKeySelected(): boolean {
        return !!this.selectedZones?.length;
    }

    public ngOnDestroy(): void {
        this.stopPressPolling();
        this.stopCalibration();
        if (!this.keyboardBacklightCapabilitiesSubscription.closed) {
            this.keyboardBacklightCapabilitiesSubscription.unsubscribe();
        }
        if (!this.keyboardBacklightKeyMapSubscription.closed) {
            this.keyboardBacklightKeyMapSubscription.unsubscribe();
        }
        if (!this.keyboardBacklightStatesSubscription.closed) {
            this.keyboardBacklightStatesSubscription.unsubscribe();
        }
    }
}
