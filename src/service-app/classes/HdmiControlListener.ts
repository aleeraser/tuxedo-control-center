import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import { defaultHdmiControlState, type HdmiControlStateInterface } from '../../common/models/TccSettings';
import type { TuxedoControlCenterDaemon } from './TuxedoControlCenterDaemon';

export class HdmiControlListener {
    private static readonly rulePath: string = '/etc/udev/rules.d/61-mutter-device-ignore.rules';
    private static readonly ruleContent: string =
        'ACTION=="add|change", SUBSYSTEM=="drm", KERNEL=="card[0-9]*", SUBSYSTEMS=="pci", DRIVERS=="nvidia", TAG+="mutter-device-ignore"\n';

    private supported: boolean = false;

    constructor(private tccd: TuxedoControlCenterDaemon) {
        this.init();
    }

    public onActiveProfileChanged(): void {}

    private async init(): Promise<void> {
        this.supported = this.detectSupport();

        if (this.supported) {
            console.log('HdmiControlListener: Detected NVIDIA dGPU with external display support');
            this.tccd.dbusData.hdmiControlEnabledNewJSON.subscribe(
                this.hdmiControlEnabledNewJSONSubscriptionHandler.bind(this),
            );
            await this.publishState();
            setInterval(async (): Promise<void> => {
                await this.publishState();
            }, 2000);
        } else {
            console.log('HdmiControlListener: NVIDIA dGPU / HDMI control not supported');
            this.tccd.dbusData.hdmiControlStateJSON = JSON.stringify(defaultHdmiControlState);
        }
    }

    private detectSupport(): boolean {
        try {
            if (fs.existsSync('/sys/bus/pci/drivers/nvidia')) {
                return true;
            }
            if (fs.existsSync('/sys/class/drm/card0/device/vendor')) {
                const vendor = fs.readFileSync('/sys/class/drm/card0/device/vendor', 'utf8').trim();
                if (vendor === '0x10de') {
                    return true;
                }
            }
        } catch (err: unknown) {
            console.error(`HdmiControlListener: detectSupport failed => ${err}`);
        }
        return false;
    }

    /**
     * Checks if the active desktop session / display server (Xwayland, gnome-shell)
     * currently holds /dev/dri/card0 open.
     */
    private isCardActiveInSession(): boolean {
        try {
            const out = child_process
                .execSync('fuser /dev/dri/card0 2>/dev/null', {
                    encoding: 'utf8',
                    timeout: 1000,
                })
                .trim();
            if (!out) {
                return false;
            }
            const pids = out.split(/\s+/).filter(Boolean);
            for (const pid of pids) {
                try {
                    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
                    if (
                        comm.includes('Xwayland') ||
                        comm.includes('gnome-shell') ||
                        comm.includes('mutter') ||
                        comm.includes('gdm')
                    ) {
                        return true;
                    }
                } catch {
                    // process may have exited
                }
            }
            return pids.length > 0;
        } catch {
            return false;
        }
    }

    private async publishState(): Promise<void> {
        const ruleInstalled = fs.existsSync(HdmiControlListener.rulePath);
        const sessionActive = this.isCardActiveInSession();

        // When rule is NOT installed, we expect sessionActive to be true (card0 used by display server).
        // When rule IS installed, we expect sessionActive to be false (card0 ignored by display server).
        const sessionInSync = !ruleInstalled === sessionActive;

        const state: HdmiControlStateInterface = {
            supported: this.supported,
            enabled: !ruleInstalled,
            ruleInstalled,
            sessionActive,
            sessionInSync,
        };

        this.tccd.dbusData.hdmiControlStateJSON = JSON.stringify(state);
    }

    private async hdmiControlEnabledNewJSONSubscriptionHandler(enabled: boolean): Promise<void> {
        if (enabled === undefined) {
            return;
        }

        console.log(`HdmiControlListener: setting HDMI enabled to ${enabled}`);

        try {
            if (enabled) {
                if (fs.existsSync(HdmiControlListener.rulePath)) {
                    fs.unlinkSync(HdmiControlListener.rulePath);
                }
            } else {
                fs.writeFileSync(HdmiControlListener.rulePath, HdmiControlListener.ruleContent, {
                    encoding: 'utf8',
                    mode: 0o644,
                });
            }

            child_process.execSync('udevadm control --reload-rules && udevadm trigger --subsystem-match=drm', {
                timeout: 5000,
            });
        } catch (err: unknown) {
            console.error(`HdmiControlListener: setHdmiControlEnabled failed => ${err}`);
        }

        await this.publishState();
    }
}
