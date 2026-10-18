import { Component, type OnDestroy, type OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import type { HdmiControlStateInterface } from '../../../common/models/TccSettings';
// biome-ignore lint: injection token
import { TccDBusClientService } from '../tcc-dbus-client.service';

@Component({
    selector: 'app-hdmi-control',
    templateUrl: './hdmi-control.component.html',
    styleUrls: ['./hdmi-control.component.scss'],
    standalone: false,
})
export class HdmiControlComponent implements OnInit, OnDestroy {
    public hdmiState: HdmiControlStateInterface;
    public chosenEnabled: boolean = false;
    private setPending: boolean = false;

    private hdmiStateSubscription: Subscription = new Subscription();

    constructor(private tccdbus: TccDBusClientService) {}

    public ngOnInit(): void {
        this.subscribeHdmiState();
    }

    public isSupported(): boolean {
        return this.hdmiState?.supported === true;
    }

    public isRestartRequired(): boolean {
        if (!this.hdmiState) {
            return false;
        }
        return !this.hdmiState.sessionInSync;
    }

    public rebootSystem(): void {
        window.ipc.issueReboot();
    }

    private subscribeHdmiState(): void {
        this.hdmiStateSubscription.add(
            this.tccdbus.hdmiControlState.subscribe((state: HdmiControlStateInterface): void => {
                if (state === undefined) {
                    return;
                }
                this.hdmiState = state;

                if (!this.setPending) {
                    this.chosenEnabled = state.enabled;
                }
            }),
        );
    }

    public onToggleChange(enabled: boolean): void {
        this.setPending = true;
        this.chosenEnabled = enabled;
        this.tccdbus.setHdmiControlEnabled(enabled);
        this.tccdbus.triggerUpdate().then((): void => {
            this.setPending = false;
        });
    }

    public ngOnDestroy(): void {
        if (!this.hdmiStateSubscription.closed) {
            this.hdmiStateSubscription.unsubscribe();
        }
    }
}
