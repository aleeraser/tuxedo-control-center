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

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as dbus from 'dbus-next';
import { getShippedKeyMap } from '../../common/classes/KeyboardKeyMaps';
import { fileOK, fileOKAsync, getDirectories, getSymbolicLinks } from '../../common/classes/Utils';
import {
    type KeyboardBacklightCapabilitiesInterface,
    KeyboardBacklightColorModes,
    type KeyboardBacklightKeyMapInterface,
    type KeyboardBacklightStateInterface,
} from '../../common/models/TccSettings';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class KeyboardBacklightListener {
    protected ledsWhiteOnly: string = '/sys/devices/platform/tuxedo_keyboard/leds/white:kbd_backlight';
    protected ledsWhiteOnlyNB05: string =
        '/sys/bus/platform/devices/tuxedo_nb05_kbd_backlight/leds/white:kbd_backlight';
    protected ledsRGBZones: Array<string> = [
        '/sys/devices/platform/tuxedo_keyboard/leds/rgb:kbd_backlight',
        '/sys/devices/platform/tuxedo_keyboard/leds/rgb:kbd_backlight_1',
        '/sys/devices/platform/tuxedo_keyboard/leds/rgb:kbd_backlight_2',
    ];
    protected keyboardBacklightCapabilities: KeyboardBacklightCapabilitiesInterface =
        {} as KeyboardBacklightCapabilitiesInterface;
    protected sysDBusUPowerProps: dbus.ClientInterface = {} as dbus.ClientInterface;
    protected sysDBusUPowerKbdBacklightInterface: dbus.ClientInterface = {} as dbus.ClientInterface;
    protected onStartRetryCount: number = 5;

    // Per-key press-to-select support
    private keyMap: KeyboardBacklightKeyMapInterface = {};
    private evdevChildren: child_process.ChildProcess[] = [];
    private flashTimers: Map<number, NodeJS.Timeout> = new Map<number, NodeJS.Timeout>();
    private highlightOriginal: Map<number, string> = new Map<number, string>();

    constructor(private tccd: TuxedoControlCenterDaemon) {
        this.init();
    }

    private async init(): Promise<void> {
        this.updateKeyboardBacklightCapabilities();

        if (this.keyboardBacklightCapabilities.zones === undefined && this.onStartRetryCount) {
            console.log('KeyboardBacklightListener: Could not find keyboard backlight, retrying');
            --this.onStartRetryCount;
            setTimeout((): void => {
                this.init();
            }, 1000);
            return;
        }

        if (this.keyboardBacklightCapabilities?.zones !== undefined) {
            // Init state in settings if not yet done or anything is wonky
            if (this.keyboardBacklightCapabilities.zones !== this.tccd.settings.keyboardBacklightStates?.length) {
                this.tccd.settings.keyboardBacklightStates = [];
                for (let i: number = 0; i < this.keyboardBacklightCapabilities.zones; ++i) {
                    this.tccd.settings.keyboardBacklightStates[i] = {
                        mode: this.keyboardBacklightCapabilities.modes[0],
                        brightness: this.keyboardBacklightCapabilities.maxBrightness,
                        red: this.keyboardBacklightCapabilities.maxRed,
                        green: this.keyboardBacklightCapabilities.maxGreen,
                        blue: this.keyboardBacklightCapabilities.maxBlue,
                    };
                }
                this.tccd.config.writeSettingsAsync(this.tccd.settings);
            }

            await this.initUPower();
            await this.initSysFSListener();
            this.tccd.dbusData.keyboardBacklightStatesNewJSON.subscribe(
                this.keyboardBacklightStatesNewJSONSubscriptionHandler.bind(this),
            );

            if (this.keyboardBacklightCapabilities.zones > 4) {
                this.loadKeyMap();
                this.startKeyPressCapture();
            }

            if (this.tccd.settings.keyboardBacklightControlEnabled) {
                this.setKeyboardBacklightStates(this.tccd.settings.keyboardBacklightStates, true, false, true);
            }
        }

        if (this.keyboardBacklightCapabilities.zones === undefined) {
            console.log('KeyboardBacklightListener: Failed to configure keyboard backlight');
        }
    }

    public onActiveProfileChanged(): void {}

    // Input from SysFS
    private async initUPower(): Promise<void> {
        const sysDBus: dbus.MessageBus = dbus.systemBus();

        // Props to poll LidIsClosed status when required
        const sysDBusUPowerObject: dbus.ProxyObject = await sysDBus.getProxyObject(
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
        );

        this.sysDBusUPowerProps = sysDBusUPowerObject.getInterface('org.freedesktop.DBus.Properties');
        let sysDBusUPowerKbdBacklightObject: dbus.ProxyObject = undefined;

        // Tuxedo OS
        try {
            sysDBusUPowerKbdBacklightObject = await sysDBus.getProxyObject(
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/KbdBacklight',
            );
            console.log('KeyboardBacklightListener: initUPower: Using /org/freedesktop/UPower/KbdBacklight');

            this.sysDBusUPowerKbdBacklightInterface = sysDBusUPowerKbdBacklightObject.getInterface(
                'org.freedesktop.UPower.KbdBacklight',
            );
        } catch (_err: unknown) {
            sysDBusUPowerKbdBacklightObject = undefined;
            console.error(
                'KeyboardBacklightListener: initUPower: /org/freedesktop/UPower/KbdBacklight does not exist, trying different path',
            );

            // Fedora
            try {
                sysDBusUPowerKbdBacklightObject = await sysDBus.getProxyObject(
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower/KbdBacklight/rgbokbd_backlight',
                );
                console.log(
                    'KeyboardBacklightListener: initUPower: Using /org/freedesktop/UPower/KbdBacklight/rgbokbd_backlight',
                );

                this.sysDBusUPowerKbdBacklightInterface = sysDBusUPowerKbdBacklightObject.getInterface(
                    'org.freedesktop.UPower.KbdBacklight',
                );
            } catch (_err: unknown) {
                console.error(
                    'KeyboardBacklightListener: initUPower: /org/freedesktop/UPower/KbdBacklight/rgbokbd_backlight does not exist',
                );
                return;
            }
        }

        this.sysDBusUPowerKbdBacklightInterface.on(
            'BrightnessChanged',
            async function (brightness: number): Promise<void> {
                if (!(await this.sysDBusUPowerProps.Get('org.freedesktop.UPower', 'LidIsClosed')).value) {
                    const keyboardBacklightStatesNew: Array<KeyboardBacklightStateInterface> =
                        this.tccd.settings.keyboardBacklightStates;
                    if (keyboardBacklightStatesNew) {
                        for (const i in keyboardBacklightStatesNew) {
                            if (keyboardBacklightStatesNew[i]) {
                                keyboardBacklightStatesNew[i].brightness = brightness;
                            }
                        }
                    }
                    this.setKeyboardBacklightStates(keyboardBacklightStatesNew, false, true, true);
                }
            }.bind(this),
        );
    }

    private async initSysFSListener(): Promise<void> {
        if (this.keyboardBacklightCapabilities.maxRed !== undefined) {
            for (let i: number = 0; i < this.ledsRGBZones?.length; ++i) {
                if (this.ledsRGBZones[i]) {
                    if (await fileOKAsync(`${this.ledsRGBZones[i]}/multi_intensity`)) {
                        (function (i: number): void {
                            fs.watch(
                                `${this.ledsRGBZones[i]}/multi_intensity`,
                                async function (): Promise<void> {
                                    if (
                                        !(await this.sysDBusUPowerProps.Get('org.freedesktop.UPower', 'LidIsClosed'))
                                            .value
                                    ) {
                                        const keyboardBacklightStatesNew: Array<KeyboardBacklightStateInterface> =
                                            this.tccd.settings.keyboardBacklightStates;
                                        const colors: number[] = (
                                            await fs.promises.readFile(`${this.ledsRGBZones[i]}/multi_intensity`)
                                        )
                                            .toString()
                                            .split(' ')
                                            .map(Number);
                                        if (keyboardBacklightStatesNew?.[i] && colors) {
                                            keyboardBacklightStatesNew[i].red = colors[0];
                                            keyboardBacklightStatesNew[i].green = colors[1];
                                            keyboardBacklightStatesNew[i].blue = colors[2];
                                            this.setKeyboardBacklightStates(
                                                keyboardBacklightStatesNew,
                                                false,
                                                true,
                                                true,
                                            );
                                        }
                                    }
                                }.bind(this),
                            );
                        }).bind(this)(i);
                    }
                }
            }
        }
    }

    // Input from TCC

    private keyboardBacklightStatesPendingNewJSON: string = undefined;
    private keyboardBacklightStatesWritingNew: boolean = false;
    private async keyboardBacklightStatesNewJSONSubscriptionHandler(
        keyboardBacklightStatesNewJSON: string,
    ): Promise<void> {
        if (keyboardBacklightStatesNewJSON !== undefined) {
            this.keyboardBacklightStatesPendingNewJSON = keyboardBacklightStatesNewJSON;

            if (this.keyboardBacklightStatesWritingNew === false) {
                this.keyboardBacklightStatesWritingNew = true;
                while (this.keyboardBacklightStatesPendingNewJSON !== undefined) {
                    const keyboardBacklightStatesNew: Array<KeyboardBacklightStateInterface> = JSON.parse(
                        this.keyboardBacklightStatesPendingNewJSON,
                    );
                    this.keyboardBacklightStatesPendingNewJSON = undefined;
                    await this.setKeyboardBacklightStates(keyboardBacklightStatesNew, true, true, false);
                }
                this.keyboardBacklightStatesWritingNew = false;
            }
        }
    }

    // Utility
    private updateKeyboardBacklightCapabilities(): void {
        this.keyboardBacklightCapabilities = {} as KeyboardBacklightCapabilitiesInterface;
        this.keyboardBacklightCapabilities.modes = [KeyboardBacklightColorModes.static];
        let ledsWhitePath: string;

        if (fileOK(`${this.ledsWhiteOnly}/max_brightness`)) {
            ledsWhitePath = this.ledsWhiteOnly;
        } else if (fileOK(`${this.ledsWhiteOnlyNB05}/max_brightness`)) {
            ledsWhitePath = this.ledsWhiteOnlyNB05;
        }

        if (ledsWhitePath) {
            console.log('KeyboardBacklightListener: Detected white only keyboard backlight');
            this.keyboardBacklightCapabilities.maxBrightness = Number(
                fs.readFileSync(`${ledsWhitePath}/max_brightness`),
            );
            this.keyboardBacklightCapabilities.zones = 1;
        } else {
            this.updateLEDSRGBZonesForPerKeyKBL();

            if (this.ledsRGBZones?.length <= 3 && fileOK(`${this.ledsRGBZones[0]}/max_brightness`)) {
                console.log('KeyboardBacklightListener: Detected RGB zone keyboard backlight');
                this.keyboardBacklightCapabilities.maxBrightness = Number(
                    fs.readFileSync(`${this.ledsRGBZones[0]}/max_brightness`),
                );
                this.keyboardBacklightCapabilities.maxRed = 0xff;
                this.keyboardBacklightCapabilities.maxGreen = 0xff;
                this.keyboardBacklightCapabilities.maxBlue = 0xff;
                this.keyboardBacklightCapabilities.zones = 1;
                if (fileOK(`${this.ledsRGBZones[1]}/max_brightness`)) {
                    this.keyboardBacklightCapabilities.zones++;
                }
                if (fileOK(`${this.ledsRGBZones[2]}/max_brightness`)) {
                    console.log('KeyboardBacklightListener: Detected RGB 3 zone keyboard backlight');
                    this.keyboardBacklightCapabilities.zones++;
                }
            } else if (this.ledsRGBZones?.length > 3 && fileOK(`${this.ledsRGBZones[0]}/max_brightness`)) {
                console.log('KeyboardBacklightListener: Detected per-key RGB keyboard backlight');
                this.keyboardBacklightCapabilities.maxBrightness = Number(
                    fs.readFileSync(`${this.ledsRGBZones[0]}/max_brightness`),
                );
                this.keyboardBacklightCapabilities.maxRed = 0xff;
                this.keyboardBacklightCapabilities.maxGreen = 0xff;
                this.keyboardBacklightCapabilities.maxBlue = 0xff;
                this.keyboardBacklightCapabilities.zones = this.ledsRGBZones?.length;
            } else {
                console.log('KeyboardBacklightListener: Detected no keyboard backlight');
                this.tccd.dbusData.keyboardBacklightCapabilitiesJSON = '{}';
                return;
            }
        }

        this.tccd.dbusData.keyboardBacklightCapabilitiesJSON = JSON.stringify(this.keyboardBacklightCapabilities);
    }

    private updateLEDSRGBZonesForPerKeyKBL(): void {
        let ledsPerKey: string[] = [];

        const keyboardPaths: string[] = [
            '/sys/bus/hid/drivers/tuxedo-keyboard-ite/',
            '/sys/bus/hid/drivers/ite_829x/',
            '/sys/bus/hid/drivers/ite_8291/',
            '/sys/bus/platform/drivers/tuxedo_nb04_kbd_backlight/',
        ];

        for (const keyboardPath of keyboardPaths) {
            if (fs.existsSync(keyboardPath)) {
                const iteKeyboardDevices: string[] = getSymbolicLinks(keyboardPath).filter((name: string): boolean =>
                    fileOK(`${keyboardPath + name}/leds`),
                );

                for (const iteKeyboardDevice of iteKeyboardDevices) {
                    const path: string = `${keyboardPath + iteKeyboardDevice}/leds`;
                    if (fileOK(path)) {
                        ledsPerKey = ledsPerKey.concat(
                            getDirectories(path)
                                .filter((name: string): boolean => name.includes('rgb:kbd_backlight'))
                                .sort(
                                    (a: string, b: string): number =>
                                        +a.replace('rgb:kbd_backlight_', '').replace('rgb:kbd_backlight', '0') -
                                        +b.replace('rgb:kbd_backlight_', '').replace('rgb:kbd_backlight', '0'),
                                )
                                .map((name: string): string => `${path}/${name}`),
                        );
                    }
                }
            }
        }

        if (ledsPerKey?.length > 0) {
            this.ledsRGBZones = ledsPerKey;
        }
    }

    private async setBufferInput(ledPath: string, bufferOn: boolean): Promise<void> {
        const bufferedInputPath: string = `${ledPath}/device/controls/buffer_input`;
        if (await fileOKAsync(bufferedInputPath)) {
            if (bufferOn) {
                await fs.promises.appendFile(bufferedInputPath, '1');
            } else {
                await fs.promises.appendFile(bufferedInputPath, '0');
            }
        }
    }

    protected async setKeyboardBacklightStates(
        keyboardBacklightStatesNew: Array<KeyboardBacklightStateInterface>,
        updateSysFS: boolean = true,
        updateSettings: boolean = true,
        updateTCC: boolean = true,
    ): Promise<void> {
        if (updateSysFS) {
            try {
                await this.sysDBusUPowerKbdBacklightInterface.SetBrightness(keyboardBacklightStatesNew[0].brightness);
            } catch (err: unknown) {
                console.error(`KeyboardBacklightListener: setKeyboardBacklightStates failed => ${err}`);
                // todo: error handling
                if (err instanceof dbus.DBusError) {
                    console.log(
                        'Failed to write brightness using UPower: Try restarting upower.service followed by tccd.service using systemctl.',
                    );
                }
            }

            if (this.ledsRGBZones?.length > 0) {
                this.setBufferInput(this.ledsRGBZones[0], true);
            }
            for (let i: number = 0; i < this.ledsRGBZones?.length; ++i) {
                if (this.ledsRGBZones[i]) {
                    if (await fileOKAsync(`${this.ledsRGBZones[i]}/multi_intensity`)) {
                        if (keyboardBacklightStatesNew?.[i]) {
                            const red: string = keyboardBacklightStatesNew[i].red.toString();
                            const green: string = keyboardBacklightStatesNew[i].green.toString();
                            const blue: string = keyboardBacklightStatesNew[i].blue.toString();

                            await fs.promises.appendFile(
                                `${this.ledsRGBZones[i]}/multi_intensity`,
                                `${red} ${green} ${blue}`,
                            );
                        }
                    }
                }
            }
            if (this.ledsRGBZones?.length > 0) {
                this.setBufferInput(this.ledsRGBZones[0], false);
            }
        }

        if (updateSettings) {
            this.tccd.settings.keyboardBacklightStates = keyboardBacklightStatesNew;
            await this.tccd.config.writeSettingsAsync(this.tccd.settings);
        }

        if (updateTCC) {
            this.tccd.dbusData.keyboardBacklightStatesJSON = JSON.stringify(keyboardBacklightStatesNew);
        }

        this.tccd.dbusData.keyboardBacklightStatesJSONSubject.next(JSON.stringify(keyboardBacklightStatesNew));
    }

    // Per-key press-to-select support

    private readBoardName(): string {
        try {
            return fs.readFileSync('/sys/class/dmi/id/board_name').toString().trim();
        } catch (_err: unknown) {
            return undefined;
        }
    }

    private loadKeyMap(): void {
        const shipped: KeyboardBacklightKeyMapInterface = getShippedKeyMap(this.readBoardName());
        const user: KeyboardBacklightKeyMapInterface = this.tccd.settings.keyboardBacklightKeyMap ?? {};
        this.keyMap = { ...shipped, ...user };
        this.tccd.dbusData.keyboardBacklightKeyMapJSON = JSON.stringify(this.keyMap);
    }

    public setKeyMapEntry(keycode: number, ledIndex: number): boolean {
        if (!Number.isInteger(keycode)) {
            return false;
        }
        if (ledIndex < 0) {
            // Remove a mapping (used to fix a wrongly assigned key before re-calibrating).
            delete this.keyMap[keycode];
        } else {
            if (!Number.isInteger(ledIndex) || ledIndex >= (this.ledsRGBZones?.length ?? 0)) {
                return false;
            }
            this.keyMap[keycode] = ledIndex;
        }
        this.tccd.settings.keyboardBacklightKeyMap = this.keyMap;
        this.tccd.config.writeSettingsAsync(this.tccd.settings);
        this.tccd.dbusData.keyboardBacklightKeyMapJSON = JSON.stringify(this.keyMap);
        return true;
    }

    public highlightLed(ledIndex: number, on: boolean): boolean {
        const ledPath: string = this.ledsRGBZones?.[ledIndex];
        if (!ledPath || !fileOK(`${ledPath}/multi_intensity`)) {
            return false;
        }
        if (on) {
            if (!this.highlightOriginal.has(ledIndex)) {
                let original: string = '0 0 0';
                try {
                    original = fs.readFileSync(`${ledPath}/multi_intensity`).toString().trim() || '0 0 0';
                } catch (_err: unknown) {
                    // keep default
                }
                this.highlightOriginal.set(ledIndex, original);
            }
            fs.promises.appendFile(`${ledPath}/multi_intensity`, '255 0 0').catch((err: unknown): void => {
                console.error(`KeyboardBacklightListener: highlightLed set failed => ${err}`);
            });
        } else {
            const original: string = this.highlightOriginal.get(ledIndex) ?? '0 0 0';
            this.highlightOriginal.delete(ledIndex);
            fs.promises.appendFile(`${ledPath}/multi_intensity`, original).catch((err: unknown): void => {
                console.error(`KeyboardBacklightListener: highlightLed restore failed => ${err}`);
            });
        }
        return true;
    }

    public flashLed(ledIndex: number): boolean {
        const ledPath: string = this.ledsRGBZones?.[ledIndex];
        if (!ledPath || !fileOK(`${ledPath}/multi_intensity`)) {
            return false;
        }

        // Cancel any pending restore for this index, then flash bright and restore afterwards.
        const pending: NodeJS.Timeout = this.flashTimers.get(ledIndex);
        if (pending) {
            clearTimeout(pending);
        }

        let previous: string = '0 0 0';
        try {
            previous = fs.readFileSync(`${ledPath}/multi_intensity`).toString().trim() || '0 0 0';
        } catch (_err: unknown) {
            // keep default
        }

        fs.promises.appendFile(`${ledPath}/multi_intensity`, '255 0 0').catch((err: unknown): void => {
            console.error(`KeyboardBacklightListener: flashLed set failed => ${err}`);
        });

        const timer: NodeJS.Timeout = setTimeout((): void => {
            this.flashTimers.delete(ledIndex);
            fs.promises.appendFile(`${ledPath}/multi_intensity`, previous).catch((err: unknown): void => {
                console.error(`KeyboardBacklightListener: flashLed restore failed => ${err}`);
            });
        }, 400);
        this.flashTimers.set(ledIndex, timer);
        return true;
    }

    private findEvdevPaths(): string[] {
        // The keyboard is NOT necessarily tied to the LED controller's USB device (e.g. on some
        // boards the keys come from the PS/2 "AT Translated Set 2 keyboard" while the ITE device
        // only drives the LEDs). Detect full keyboards by their EV_KEY capability bitmap and open
        // all of them, so a press on the built-in keyboard is captured regardless of which device
        // it belongs to.
        let events: string[];
        try {
            events = fs.readdirSync('/sys/class/input');
        } catch (_err: unknown) {
            return [];
        }

        const paths: string[] = [];
        for (const event of events) {
            if (!event.startsWith('event')) {
                continue;
            }
            const score: number = this.keyboardCapabilityScore(`/sys/class/input/${event}/device/capabilities/key`);
            if (score >= 40) {
                paths.push(`/dev/input/${event}`);
            }
        }
        return paths;
    }

    // Returns the number of set KEY_* bits, or -1 if this is not a full keyboard
    // (must report ESC=1, ENTER=28, A=30, Z=44).
    private keyboardCapabilityScore(capFile: string): number {
        let caps: string;
        try {
            caps = fs.readFileSync(capFile).toString().trim();
        } catch (_err: unknown) {
            return -1;
        }
        const words: string[] = caps.split(/\s+/).filter((w: string): boolean => w.length > 0);
        if (words.length === 0) {
            return -1;
        }
        // Kernel prints capability words most-significant first; the LAST word holds bits 0-63.
        const word0: string = words[words.length - 1];
        if (!this.hexBitSet(word0, 1) || !this.hexBitSet(word0, 28) || !this.hexBitSet(word0, 30) || !this.hexBitSet(word0, 44)) {
            return -1;
        }
        let count: number = 0;
        for (const word of words) {
            for (let i: number = 0; i < word.length; ++i) {
                count += this.popcountNibble(word.charCodeAt(i));
            }
        }
        return count;
    }

    // Is bit `bit` (0-63) set in a hex word string (up to 16 hex digits)?
    private hexBitSet(hexWord: string, bit: number): boolean {
        const charIndex: number = hexWord.length - 1 - Math.floor(bit / 4);
        if (charIndex < 0) {
            return false;
        }
        const nibble: number = Number.parseInt(hexWord[charIndex], 16);
        if (Number.isNaN(nibble)) {
            return false;
        }
        return ((nibble >> (bit % 4)) & 1) === 1;
    }

    private popcountNibble(charCode: number): number {
        let nibble: number;
        if (charCode >= 48 && charCode <= 57) {
            nibble = charCode - 48; // 0-9
        } else if (charCode >= 97 && charCode <= 102) {
            nibble = charCode - 97 + 10; // a-f
        } else if (charCode >= 65 && charCode <= 70) {
            nibble = charCode - 65 + 10; // A-F
        } else {
            return 0;
        }
        let count: number = 0;
        while (nibble) {
            count += nibble & 1;
            nibble >>= 1;
        }
        return count;
    }

    private startKeyPressCapture(): void {
        if (this.evdevChildren.length > 0) {
            return;
        }
        const evdevPaths: string[] = this.findEvdevPaths();
        if (evdevPaths.length === 0) {
            console.log('KeyboardBacklightListener: per-key press capture disabled (no keyboard evdev device found)');
            return;
        }
        for (const evdevPath of evdevPaths) {
            this.openEvdevReader(evdevPath);
        }
        console.log(`KeyboardBacklightListener: per-key press capture active (${evdevPaths.join(', ')})`);
    }

    private openEvdevReader(evdevPath: string): void {
        let child: child_process.ChildProcess;
        try {
            child = child_process.spawn('cat', [evdevPath], {
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch (err: unknown) {
            console.error(`KeyboardBacklightListener: failed to spawn reader for ${evdevPath} => ${err}`);
            return;
        }
        this.evdevChildren.push(child);

        let pending: Buffer = Buffer.alloc(0);

        child.stdout?.on('data', (data: Buffer): void => {
            pending = Buffer.concat([pending, data]);
            // struct input_event on 64-bit: tv_sec(8) tv_usec(8) type(u16) code(u16) value(s32) = 24 bytes
            while (pending.length >= 24) {
                const record: Buffer = pending.subarray(0, 24);
                pending = pending.subarray(24);
                const type: number = record.readUInt16LE(16);
                const code: number = record.readUInt16LE(18);
                const value: number = record.readInt32LE(20);
                if (type === 1 && value === 1) {
                    // EV_KEY, key press
                    this.onKeyPressed(code);
                }
            }
        });

        child.on('error', (err: Error): void => {
            console.error(`KeyboardBacklightListener: evdev read error (${evdevPath}) => ${err}`);
        });
    }

    private onKeyPressed(keycode: number): void {
        this.tccd.dbusData.keyboardBacklightKeyPressedJSON = JSON.stringify({ keycode });
    }

    public exit(): void {
        for (const timer of this.flashTimers.values()) {
            clearTimeout(timer);
        }
        this.flashTimers.clear();

        for (const child of this.evdevChildren) {
            try {
                child.kill('SIGKILL');
            } catch (_err: unknown) {
                // child process already exited
            }
        }
        this.evdevChildren = [];
    }
}
