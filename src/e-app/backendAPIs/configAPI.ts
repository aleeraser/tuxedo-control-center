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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { app, ipcMain } from 'electron';
import { ConfigHandler } from '../../common/classes/ConfigHandler';
import { TccPaths } from '../../common/classes/TccPaths';
import type { ITccProfile } from '../../common/models/TccProfile';
import type { ITccSettings } from '../../common/models/TccSettings';
import { execFile, execFileSync, getTccdExec } from './utilsAPI';

const config: ConfigHandler = new ConfigHandler(
    TccPaths.SETTINGS_FILE,
    TccPaths.PROFILES_FILE,
    TccPaths.WEBCAM_FILE,
    TccPaths.V4L2_NAMES_FILE,
    TccPaths.FANTABLES_FILE,
);

function syncRepoProfiles(profiles: ITccProfile[]): void {
    try {
        const candidates = [
            path.resolve(app.getAppPath(), '../../profiles-recoil16.json'),
            path.resolve(__dirname, '../../../../../profiles-recoil16.json'),
            path.join(process.env.HOME || '', 'git/tuxedo/tuxedo-control-center/profiles-recoil16.json'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                fs.writeFileSync(candidate, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
                break;
            }
        }
    } catch (err: unknown) {
        console.error(`configAPI: syncRepoProfiles failed => ${err}`);
    }
}

async function pkexecWriteCustomProfilesAsync(newProfileList: ITccProfile[]): Promise<boolean> {
    const tmpProfilesPath: string = '/tmp/tmptccprofiles';
    config.writeProfiles(newProfileList, tmpProfilesPath);
    const tccdExec: string = getTccdExec();

    try {
        await execFile(`pkexec ${tccdExec} --new_profiles ${tmpProfilesPath}`);
        syncRepoProfiles(newProfileList);
        return true;
    } catch (err: unknown) {
        console.error(`configAPI: pkexecWriteCustomProfilesAsync failed => ${err}`);
        return false;
    }
}

function pkexecWriteCustomProfiles(profiles: ITccProfile[]): boolean {
    const tmpProfilesPath = '/tmp/tmptccprofiles';
    config.writeProfiles(profiles, tmpProfilesPath);
    const tccdExec: string = getTccdExec();
    // https://stackoverflow.com/questions/57484453/how-to-get-err-stderr-from-execsync
    try {
        execFileSync(`pkexec ${tccdExec} --new_profiles ${tmpProfilesPath}`);
        syncRepoProfiles(profiles);
        return true;
    } catch (err: unknown) {
        console.error(`configAPI: pkexecWriteCustomProfiles failed => ${err}`);
        return false;
    }
}

async function pkexecWriteConfigAsync(settings: ITccSettings, profiles: ITccProfile[]): Promise<boolean> {
    const tmpProfilesPath = '/tmp/tmptccprofiles';
    const tmpSettingsPath = '/tmp/tmptccsettings';
    config.writeProfiles(profiles, tmpProfilesPath);
    config.writeSettings(settings, tmpSettingsPath);
    const tccdExec: string = getTccdExec();

    return new Promise<boolean>(
        (resolve: (value: boolean | PromiseLike<boolean>) => void, _reject: (reason?: unknown) => void): void => {
            execFile(`pkexec ${tccdExec} --new_profiles ${tmpProfilesPath} --new_settings ${tmpSettingsPath}`)
                .then((data: { data: string; error: unknown }): void => {
                    if (data.error) {
                        resolve(false);
                    } else {
                        syncRepoProfiles(profiles);
                        resolve(true);
                    }
                })
                .catch((err: unknown): void => {
                    console.error('configAPI: pkexecWriteConfigAsync failed =>', err);
                    resolve(false);
                });
        },
    );
}

ipcMain.on(
    'config-set-active-profile',
    (_event: IpcMainEvent, profileId: string, stateId: string, settings: ITccSettings): void => {
        // Copy existing current settings and set id of new profile
        const newSettings: ITccSettings = config.copyConfig<ITccSettings>(settings);

        newSettings.stateMap[stateId] = profileId;
        const tmpSettingsPath = '/tmp/tmptccsettings';
        config.writeSettings(newSettings, tmpSettingsPath);
        const tccdExec: string = getTccdExec();
        // todo: error handling
        execFile(`pkexec ${tccdExec} --new_settings ${tmpSettingsPath}`);
    },
);

ipcMain.on('config-pkexec-write-custom-profiles', (event: IpcMainEvent, customProfiles: ITccProfile[]): void => {
    event.returnValue = pkexecWriteCustomProfiles(customProfiles);
});

ipcMain.handle(
    'config-pkexec-write-custom-profiles-async',
    (_event: IpcMainInvokeEvent, customProfiles: ITccProfile[]): Promise<boolean> => {
        return pkexecWriteCustomProfilesAsync(customProfiles);
    },
);

ipcMain.handle(
    'config-pkexec-write-config-async',
    (_event: IpcMainInvokeEvent, settings: ITccSettings, customProfiles: ITccProfile[]): Promise<boolean> => {
        return pkexecWriteConfigAsync(settings, customProfiles);
    },
);

ipcMain.on('config-get-default-fan-profiles', (event: IpcMainEvent): void => {
    event.returnValue = config.getDefaultFanProfiles();
});
