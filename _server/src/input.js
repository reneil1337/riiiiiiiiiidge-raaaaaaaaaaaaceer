// Browser pad state -> native PSX pad state.
// The native runtime samples two independent keyboard pads (see keybinds.ini),
// so each PSX button is represented by a distinct host key.
import { sendKey, tapKey, focusWindow, getForegroundWindow } from './win32.js';

// PSX active-low bit -> Windows virtual-key code.
const P1 = {
  0x0001: 0xA1, // Select  -> Right Shift
  0x0002: 0x54, // L3      -> T
  0x0004: 0x59, // R3      -> Y
  0x0008: 0x0D, // Start   -> Enter
  0x0010: 0x26, // Up
  0x0020: 0x27, // Right
  0x0040: 0x28, // Down
  0x0080: 0x25, // Left
  0x0100: 0x45, // L2      -> E
  0x0200: 0x52, // R2      -> R
  0x0400: 0x51, // L1      -> Q
  0x0800: 0x57, // R1      -> W
  0x1000: 0x41, // Triangle-> A
  0x2000: 0x53, // Circle  -> S
  0x4000: 0x58, // Cross   -> X
  0x8000: 0x5A, // Square  -> Z
};

const P2 = {
  0x0001: 0x09, // Select  -> Tab
  0x0002: 0x00, // L3 (unbound)
  0x0004: 0x00, // R3 (unbound)
  0x0008: 0x08, // Start   -> Backspace
  0x0010: 0x49, // Up      -> I
  0x0020: 0x4C, // Right   -> L
  0x0040: 0x4B, // Down    -> K
  0x0080: 0x4A, // Left    -> J
  0x0100: 0x50, // L2      -> P
  0x0200: 0xBA, // R2      -> ;
  0x0400: 0x55, // L1      -> U
  0x0800: 0x4F, // R1      -> O
  0x1000: 0x48, // Triangle-> H
  0x2000: 0x4D, // Circle  -> M
  0x4000: 0x4E, // Cross   -> N
  0x8000: 0xBC, // Square  -> ,
};

const MAPS = [P1, P2];
const NEUTRAL = 0xFFFF;

// Pure mapping used by the relay and by offline tests. The PSX pad word is
// active-low, so a zero bit means the button is pressed.
export function keysForMask(player, mask) {
  const map = MAPS[player === 2 ? 1 : 0];
  const out = [];
  mask = Number.isFinite(mask) ? (mask & 0xFFFF) : NEUTRAL;
  for (const bit of Object.keys(map)) {
    const b = Number(bit);
    const vk = map[b];
    if (vk && (mask & b) === 0) out.push(vk);
  }
  return out;
}

export class InputBridge {
  constructor({ onLog } = {}) {
    this.hwnd = null;
    this.masks = [NEUTRAL, NEUTRAL];
    this.pressed = [new Set(), new Set()];
    this.onLog = onLog || (() => {});
  }

  setWindow(hwnd) {
    this.hwnd = hwnd;
  }

  setMask(player, mask) {
    const p = player === 2 ? 1 : 0;
    mask = Number.isFinite(mask) ? (mask & 0xFFFF) : NEUTRAL;
    if (mask === this.masks[p]) return;
    const desired = new Set(keysForMask(player, mask));
    const prev = this.pressed[p];
    if (desired.size || prev.size) {
      this.ensureFocus();
    }
    for (const vk of prev) {
      if (!desired.has(vk)) sendKey(vk, false);
    }
    for (const vk of desired) {
      if (!prev.has(vk)) sendKey(vk, true);
    }
    this.pressed[p] = desired;
    this.masks[p] = mask;
  }

  async tapStart(player = 1) {
    const p = player === 2 ? 1 : 0;
    const vk = MAPS[p][0x0008];
    this.ensureFocus();
    await tapKey(vk, 140);
  }

  async tap(vk, hold = 120) {
    this.ensureFocus();
    await tapKey(vk, hold);
  }

  releaseAll() {
    let any = false;
    for (let p = 0; p < 2; p++) if (this.pressed[p].size) any = true;
    if (any) this.ensureFocus();
    for (let p = 0; p < 2; p++) {
      for (const vk of this.pressed[p]) sendKey(vk, false);
      this.pressed[p].clear();
      this.masks[p] = NEUTRAL;
    }
  }

  resend() {
    if (!this.hwnd) return;
    this.ensureFocus();
    for (let p = 0; p < 2; p++) {
      for (const vk of this.pressed[p]) sendKey(vk, true);
    }
  }

  ensureFocus() {
    if (!this.hwnd) return false;
    if (getForegroundWindow() === this.hwnd) return false;
    focusWindow(this.hwnd);
    return true;
  }
}
