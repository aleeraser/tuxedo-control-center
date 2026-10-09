import { Component, type OnDestroy, type OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import type { LocalDimmingStateInterface } from '../../../common/models/TccSettings';
// biome-ignore lint: injection token
import { TccDBusClientService } from '../tcc-dbus-client.service';

@Component({
    selector: 'app-local-dimming-control',
    templateUrl: './local-dimming-control.component.html',
    styleUrls: ['./local-dimming-control.component.scss'],
    standalone: false,
})
export class LocalDimmingControlComponent implements OnInit, OnDestroy {
    public localDimmingState: LocalDimmingStateInterface;
    public chosenEnabled: boolean = false;
    private setPending: boolean = false;

    private localDimmingStateSubscription: Subscription = new Subscription();

    constructor(private tccdbus: TccDBusClientService) {}

    public ngOnInit(): void {
        this.subscribeLocalDimmingState();
    }

    public isSupported(): boolean {
        return this.localDimmingState?.supported === true;
    }

    private subscribeLocalDimmingState(): void {
        this.localDimmingStateSubscription.add(
            this.tccdbus.localDimmingState.subscribe((localDimmingState: LocalDimmingStateInterface): void => {
                if (localDimmingState === undefined) {
                    return;
                }
                this.localDimmingState = localDimmingState;

                if (!this.setPending) {
                    this.chosenEnabled = localDimmingState.enabled;
                }
            }),
        );
    }

    public onToggleChange(enabled: boolean): void {
        this.setPending = true;
        this.chosenEnabled = enabled;
        this.tccdbus.setLocalDimmingEnabled(enabled);
        this.tccdbus.triggerUpdate().then((): void => {
            this.setPending = false;
        });
    }

    public ngOnDestroy(): void {
        if (!this.localDimmingStateSubscription.closed) {
            this.localDimmingStateSubscription.unsubscribe();
        }
    }
}
