import type { KeyboardBacklightKeyMapInterface } from '../models/TccSettings';

/**
 * Shipped per-key LED maps (option "C" of the per-key backlight design).
 *
 * Keys are DMI board names (substring match, case-insensitive). Values map a Linux
 * input keycode (linux/input-event-codes.h KEY_*) to the ITE per-key LED index
 * (rgb:kbd_backlight[_N], N == index).
 *
 * These boards use a sparse, non-geometric LED matrix and the driver exposes no
 * keymap, so only reliably-known keys are pre-seeded here. Any remaining keys are
 * filled in at runtime by the in-app calibration wizard (option "B") and stored in
 * settings.keyboardBacklightKeyMap, which is merged on top of these shipped values.
 */
export const shippedKeyboardKeyMaps: { [boardName: string]: KeyboardBacklightKeyMapInterface } = {
    // Recoil IV 16 (AiStone X6AF559Y). LED index = row*21 + col (6 rows x 21 cols).
    // Anchors (probed): a=44(r2c2) s=45(same row) d=46 w=66(r3c3) z=24(r1c3) Enter=77 End=124.
    // Letters are derived from that QWERTY grid; keycodes are linux/input-event-codes.h KEY_*.
    X6AF559Y: {
        // Row 3 (QWERTY): q=col2 .. p=col11, then [ ]
        16: 65, // Q
        17: 66, // W
        18: 67, // E
        19: 68, // R
        20: 69, // T
        21: 70, // Y
        22: 71, // U
        23: 72, // I
        24: 73, // O
        25: 74, // P
        26: 75, // [
        27: 76, // ]
        // Row 2 (home): a=col2 .. l=col10, then ; '
        30: 44, // A
        31: 45, // S
        32: 46, // D
        33: 47, // F
        34: 48, // G
        35: 49, // H
        36: 50, // J
        37: 51, // K
        38: 52, // L
        39: 53, // ;
        40: 54, // '
        // Row 1 (bottom): z=col3 .. m=col9, then , . /
        44: 24, // Z
        45: 25, // X
        46: 26, // C
        47: 27, // V
        48: 28, // B
        49: 29, // N
        50: 30, // M
        51: 31, // ,
        52: 32, // .
        53: 33, // /
        // Probed specials
        28: 77, // Enter
        107: 124, // End
    },
};

export function getShippedKeyMap(boardName: string | undefined): KeyboardBacklightKeyMapInterface {
    if (!boardName) {
        return {};
    }
    const needle: string = boardName.toLowerCase();
    for (const board of Object.keys(shippedKeyboardKeyMaps)) {
        if (needle.includes(board.toLowerCase())) {
            return shippedKeyboardKeyMaps[board];
        }
    }
    return {};
}
