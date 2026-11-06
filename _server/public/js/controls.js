/* Ridge Racer Type 4 LAN — input controller.
 * Keyboard, touch and browser Gamepad API (Xbox + PlayStation) -> PSX pad word.
 * The server translates the word into the native cabinet's two keyboard pads.
 */
(function () {
  'use strict';

  const BIT = {
    select: 0x0001, l3: 0x0002, r3: 0x0004, start: 0x0008,
    up: 0x0010, right: 0x0020, down: 0x0040, left: 0x0080,
    l2: 0x0100, r2: 0x0200, l1: 0x0400, r1: 0x0800,
    triangle: 0x1000, circle: 0x2000, cross: 0x4000, square: 0x8000,
  };
  const NEUTRAL = 0xFFFF;

  const P1_KEYS = {
    ArrowUp: BIT.up, ArrowDown: BIT.down, ArrowLeft: BIT.left, ArrowRight: BIT.right,
    KeyZ: BIT.square, KeyX: BIT.cross, KeyA: BIT.triangle, KeyS: BIT.circle,
    KeyQ: BIT.l1, KeyW: BIT.r1, KeyE: BIT.l2, KeyR: BIT.r2,
    Enter: BIT.start, NumpadEnter: BIT.start, ShiftRight: BIT.select,
    KeyT: BIT.l3, KeyY: BIT.r3,
  };
  const P2_KEYS = {
    KeyI: BIT.up, KeyK: BIT.down, KeyJ: BIT.left, KeyL: BIT.right,
    Comma: BIT.square, KeyN: BIT.cross, KeyH: BIT.triangle, KeyM: BIT.circle,
    KeyU: BIT.l1, KeyO: BIT.r1, KeyP: BIT.l2, Semicolon: BIT.r2,
    Backspace: BIT.start, Tab: BIT.select,
  };

  const TOUCH_BITS = {
    up: BIT.up, down: BIT.down, left: BIT.left, right: BIT.right,
    triangle: BIT.triangle, circle: BIT.circle, cross: BIT.cross, square: BIT.square,
    l1: BIT.l1, r1: BIT.r1, l2: BIT.l2, r2: BIT.r2,
    start: BIT.start, select: BIT.select,
  };

  // Deadzones. Engage at the higher value, release at the lower one, so a
  // stick that rests just outside the deadzone cannot chatter.
  const STICK_ENGAGE = 0.5;
  const STICK_RELEASE = 0.34;
  const STICK_COMPONENT = 0.3;
  const TRIGGER_ENGAGE = 0.3;
  const TRIGGER_RELEASE = 0.15;
  const HAT_ENGAGE = 0.55;
  const HAT_RELEASE = 0.35;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function detectPadType(id) {
    const s = String(id || '').toLowerCase();
    if (/xbox|xinput|045e|microsoft/.test(s)) return 'xbox';
    if (/dualsense|dualshock|playstation|sony|054c/.test(s)) return 'playstation';
    return 'generic';
  }

  function padLabel(type) {
    if (type === 'playstation') return 'PlayStation';
    if (type === 'xbox') return 'Xbox';
    return 'Gamepad';
  }

  function cleanPadName(id, type) {
    let s = String(id || '');
    // Firefox prefixes ids with "054c-0ce6-".
    s = s.replace(/^[0-9a-f]{4}[-:][0-9a-f]{4}[-:]\s*/i, '');
    // Chrome appends "(STANDARD GAMEPAD Vendor: 054c Product: 0ce6)".
    s = s.replace(/\s*\([^)]*(?:standard gamepad|vendor:|product:)[^)]*\)\s*/gi, ' ');
    s = s.replace(/\b(?:vendor|product):\s*[0-9a-f]{4}\b/gi, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s || padLabel(type);
  }

  function isPs3Id(id) {
    return /playstation\(r\)3|dualshock\s*3|dualshock3|ps3|product:\s*0268|054c[-: ]*0268/i.test(String(id || ''));
  }

  function isSonyRawId(id) {
    return /wireless controller|dualshock|dualsense|sony|054c/i.test(String(id || ''));
  }

  // Some non-standard pads report their D-pad as a hat axis pair instead of
  // buttons 12-15.  Prefer the two extra axes Chrome exposes at the end of the
  // axis list; fall back to the common DirectInput 6/7 hat pair.
  function pickHat(pad) {
    const axes = pad && pad.axes ? pad.axes.length : 0;
    if (axes >= 10) return [9, 10];
    if (axes >= 8) return [6, 7];
    return null;
  }

  /* Resolve a pad's button/axis order.
   * Standard mapping is used verbatim.  Non-standard pads get a small set of
   * real-world fallbacks: raw PS3 order, raw DualShock 4/DualSense order,
   * 8-button generic pads and D-pad-as-hat pads. */
  function resolveLayout(pad) {
    const buttons = pad && pad.buttons ? pad.buttons.length : 0;
    const axes = pad && pad.axes ? pad.axes.length : 0;
    const type = detectPadType(pad && pad.id);
    const standard = !!(pad && pad.mapping === 'standard');

    const layout = {
      kind: 'standard',
      cross: 0, circle: 1, square: 2, triangle: 3,
      l1: 4, r1: 5, l2: 6, r2: 7,
      select: 8, start: 9, l3: 10, r3: 11,
      up: 12, down: 13, left: 14, right: 15,
      hat: null,
      triggerAxes: null,
    };

    if (standard) {
      if (buttons < 16) layout.up = layout.down = layout.left = layout.right = -1;
      if (buttons < 12) layout.l3 = layout.r3 = -1;
      if (buttons < 10) layout.select = layout.start = -1;
      if (buttons < 8) {
        layout.l2 = layout.r2 = -1;
        if (axes >= 6) layout.triggerAxes = [4, 5];
      }
      if (buttons < 16) layout.hat = pickHat(pad);
      return layout;
    }

    // Raw PlayStation 3 HID order: Select, L3, R3, Start, D-pad, L2/R2,
    // L1/R1, Triangle, Circle, Cross, Square.
    if (type === 'playstation' && buttons >= 12 && isPs3Id(pad.id)) {
      return {
        kind: 'ps3raw',
        select: 0, l3: 1, r3: 2, start: 3,
        up: 4, right: 5, down: 6, left: 7,
        l2: 8, r2: 9, l1: 10, r1: 11,
        triangle: 12, circle: 13, cross: 14, square: 15,
        hat: null,
        triggerAxes: null,
      };
    }

    // Raw DualShock 4 / DualSense HID order: Square, Cross, Circle, Triangle.
    if (type === 'playstation' && buttons >= 12 && buttons < 16 && isSonyRawId(pad.id)) {
      return {
        kind: 'ps4raw',
        square: 0, cross: 1, circle: 2, triangle: 3,
        l1: 4, r1: 5, l2: 6, r2: 7,
        select: 8, start: 9, l3: 10, r3: 11,
        up: -1, down: -1, left: -1, right: -1,
        hat: pickHat(pad),
        triggerAxes: null,
      };
    }

    // Most 16+ button non-standard pads still follow the W3C order.
    if (buttons >= 16) return layout;

    // 10-15 buttons: W3C order without the four D-pad buttons.
    if (buttons >= 10) {
      layout.up = layout.down = layout.left = layout.right = -1;
      if (buttons < 12) layout.l3 = layout.r3 = -1;
      layout.hat = pickHat(pad);
      return layout;
    }

    // Cheap 8/9-button retro pad: face, shoulders, Select/Start.
    if (buttons >= 8) {
      return {
        ...layout,
        kind: 'generic8',
        select: 6, start: 7,
        l2: -1, r2: -1, l3: -1, r3: -1,
        up: -1, down: -1, left: -1, right: -1,
        hat: pickHat(pad),
        triggerAxes: axes >= 6 ? [4, 5] : null,
      };
    }

    // 6/7-button pad: face + shoulders only, triggers may be axes.
    if (buttons >= 6) {
      return {
        ...layout,
        kind: 'generic6',
        select: -1, start: -1,
        l2: -1, r2: -1, l3: -1, r3: -1,
        up: -1, down: -1, left: -1, right: -1,
        hat: pickHat(pad),
        triggerAxes: axes >= 6 ? [4, 5] : null,
      };
    }

    return {
      ...layout,
      kind: 'minimal',
      l1: -1, r1: -1, l2: -1, r2: -1,
      select: -1, start: -1, l3: -1, r3: -1,
      up: -1, down: -1, left: -1, right: -1,
      hat: null,
    };
  }

  function readButton(pad, index) {
    if (!pad || !pad.buttons || index == null || index < 0) return 0;
    const b = pad.buttons[index];
    if (!b) return 0;
    if (b.pressed) return 1;
    const v = Number(b.value);
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  }

  function axisValue(pad, index) {
    if (!pad || !pad.axes || index == null || index < 0 || index >= pad.axes.length) return 0;
    const v = Number(pad.axes[index]);
    return Number.isFinite(v) ? clamp(v, -1, 1) : 0;
  }

  function calibrateAxes(pad) {
    const axes = pad && pad.axes ? pad.axes : [];
    const rest = [];
    for (let i = 0; i < axes.length; i++) {
      const v = Number(axes[i]);
      rest[i] = Number.isFinite(v) ? v : 0;
    }
    return rest;
  }

  // Analog triggers on non-standard pads are often axes.  Use the calibrated
  // rest position to normalise -1..1 and 0..1 styles without guessing.
  function triggerAxisValue(pad, rest, index) {
    const v = axisValue(pad, index);
    const r = rest && Number.isFinite(rest[index]) ? rest[index] : 0;
    if (r <= -0.5) return clamp((v + 1) / 2, 0, 1);
    if (r >= 0.5) return clamp((1 - v) / 2, 0, 1);
    return clamp(v, 0, 1);
  }

  function hysteresis(value, held, engage, release) {
    return held ? value > release : value >= engage;
  }

  function createHeld() {
    return {
      layoutKey: '',
      layout: null,
      axisRest: null,
      stickLeft: false, stickRight: false, stickUp: false, stickDown: false,
      hatLeft: false, hatRight: false, hatUp: false, hatDown: false,
      l2: false, r2: false,
    };
  }

  function padKey(pad) {
    if (!pad) return '';
    return [
      pad.index,
      pad.id,
      pad.mapping || '',
      pad.buttons ? pad.buttons.length : 0,
      pad.axes ? pad.axes.length : 0,
    ].join('|');
  }

  /* Pure-ish mapper: reads a Gamepad and returns { mask, held }.
   * `held` carries only hysteresis state; the function does not mutate the
   * pad and does not touch the DOM, so it is easy to test on its own. */
  function mapStandardPad(pad, held) {
    const prev = held || createHeld();
    const key = padKey(pad);
    let layout = prev.layout;
    let axisRest = prev.axisRest;
    if (prev.layoutKey !== key || !layout) {
      layout = resolveLayout(pad);
      axisRest = calibrateAxes(pad);
    }

    const next = {
      ...prev,
      layoutKey: key,
      layout,
      axisRest,
      stickLeft: false, stickRight: false, stickUp: false, stickDown: false,
      hatLeft: false, hatRight: false, hatUp: false, hatDown: false,
      l2: false, r2: false,
    };
    let mask = 0;

    const press = (index, bit) => {
      if (readButton(pad, index) >= 0.5) mask |= bit;
    };

    press(layout.cross, BIT.cross);
    press(layout.circle, BIT.circle);
    press(layout.square, BIT.square);
    press(layout.triangle, BIT.triangle);
    press(layout.l1, BIT.l1);
    press(layout.r1, BIT.r1);
    press(layout.select, BIT.select);
    press(layout.start, BIT.start);
    press(layout.l3, BIT.l3);
    press(layout.r3, BIT.r3);
    press(layout.up, BIT.up);
    press(layout.down, BIT.down);
    press(layout.left, BIT.left);
    press(layout.right, BIT.right);

    let l2v = 0;
    let r2v = 0;
    if (layout.l2 >= 0) l2v = readButton(pad, layout.l2);
    else if (layout.triggerAxes) l2v = triggerAxisValue(pad, axisRest, layout.triggerAxes[0]);
    if (layout.r2 >= 0) r2v = readButton(pad, layout.r2);
    else if (layout.triggerAxes) r2v = triggerAxisValue(pad, axisRest, layout.triggerAxes[1]);

    next.l2 = hysteresis(l2v, prev.l2, TRIGGER_ENGAGE, TRIGGER_RELEASE);
    next.r2 = hysteresis(r2v, prev.r2, TRIGGER_ENGAGE, TRIGGER_RELEASE);
    if (next.l2) mask |= BIT.l2;
    if (next.r2) mask |= BIT.r2;

    if (layout.hat) {
      const hx = axisValue(pad, layout.hat[0]);
      const hy = axisValue(pad, layout.hat[1]);
      next.hatLeft = hysteresis(-hx, prev.hatLeft, HAT_ENGAGE, HAT_RELEASE);
      next.hatRight = hysteresis(hx, prev.hatRight, HAT_ENGAGE, HAT_RELEASE);
      next.hatUp = hysteresis(-hy, prev.hatUp, HAT_ENGAGE, HAT_RELEASE);
      next.hatDown = hysteresis(hy, prev.hatDown, HAT_ENGAGE, HAT_RELEASE);
      if (next.hatLeft) mask |= BIT.left;
      if (next.hatRight) mask |= BIT.right;
      if (next.hatUp) mask |= BIT.up;
      if (next.hatDown) mask |= BIT.down;
    }

    // Radial deadzone with hysteresis, then a component threshold so
    // diagonals work without making the cardinal deadzone huge.
    const ax = axisValue(pad, 0);
    const ay = axisValue(pad, 1);
    const mag = Math.hypot(ax, ay);
    const wasActive = prev.stickLeft || prev.stickRight || prev.stickUp || prev.stickDown;
    const active = wasActive ? mag > STICK_RELEASE : mag >= STICK_ENGAGE;
    if (active) {
      next.stickLeft = ax <= -STICK_COMPONENT;
      next.stickRight = ax >= STICK_COMPONENT;
      next.stickUp = ay <= -STICK_COMPONENT;
      next.stickDown = ay >= STICK_COMPONENT;
      if (next.stickLeft) mask |= BIT.left;
      if (next.stickRight) mask |= BIT.right;
      if (next.stickUp) mask |= BIT.up;
      if (next.stickDown) mask |= BIT.down;
    }

    return { mask, held: next };
  }

  class InputController {
    constructor(opts = {}) {
      this.onChange = typeof opts.onChange === 'function' ? opts.onChange : (() => {});
      this.onPadStatus = typeof opts.onPadStatus === 'function' ? opts.onPadStatus : (() => {});
      this.onRumble = typeof opts.onRumble === 'function' ? opts.onRumble : (() => {});
      this.seat = 0;
      this.layout = 'auto';
      this.padSlot = 0;
      this.keyboardMask = 0;
      this.gamepadMask = 0;
      this.touchMask = 0;
      this.lastMask = NEUTRAL;
      this.keys = new Set();
      this.touchPointers = new Map();
      this.padInfo = { connected: false, name: '', type: 'generic', mapping: '', index: -1 };
      this.padInfoKey = '';
      this.raf = null;
      this.touchVisible = false;
      this.padKey = '';
      this.padHeld = createHeld();
      this.started = false;
      this._touchBound = false;
      this._touchRoot = null;
      this._keydown = this._keydown.bind(this);
      this._keyup = this._keyup.bind(this);
      this._blur = this._blur.bind(this);
      this._poll = this._poll.bind(this);
      this._onConnected = this._onConnected.bind(this);
      this._onDisconnected = this._onDisconnected.bind(this);
      this._onVisibility = this._onVisibility.bind(this);
      this._onPageHide = this._onPageHide.bind(this);
      this._touchDown = this._touchDown.bind(this);
      this._touchUp = this._touchUp.bind(this);
      this._touchContext = this._touchContext.bind(this);
    }

    start() {
      if (this.started) return this;
      this.started = true;
      // Capture phase keeps game keys from also triggering the page's F/M/H
      // shortcuts (P2 uses H and M for Triangle and Circle).
      window.addEventListener('keydown', this._keydown, { passive: false, capture: true });
      window.addEventListener('keyup', this._keyup, { passive: false, capture: true });
      window.addEventListener('blur', this._blur);
      window.addEventListener('gamepadconnected', this._onConnected);
      window.addEventListener('gamepaddisconnected', this._onDisconnected);
      document.addEventListener('visibilitychange', this._onVisibility);
      window.addEventListener('pagehide', this._onPageHide);
      this._bindTouch();
      this._updatePadStatus(true);
      this.raf = requestAnimationFrame(this._poll);
      return this;
    }

    destroy() {
      this.started = false;
      window.removeEventListener('keydown', this._keydown, { capture: true });
      window.removeEventListener('keyup', this._keyup, { capture: true });
      window.removeEventListener('blur', this._blur);
      window.removeEventListener('gamepadconnected', this._onConnected);
      window.removeEventListener('gamepaddisconnected', this._onDisconnected);
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('pagehide', this._onPageHide);
      if (this._touchBound && this._touchRoot) {
        this._touchRoot.removeEventListener('pointerdown', this._touchDown);
        this._touchRoot.removeEventListener('contextmenu', this._touchContext);
      }
      window.removeEventListener('pointerup', this._touchUp);
      window.removeEventListener('pointercancel', this._touchUp);
      window.removeEventListener('lostpointercapture', this._touchUp);
      this._touchBound = false;
      this._touchRoot = null;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this._releaseInputs(false);
    }

    setSeat(seat) {
      const n = Number(seat) === 2 ? 2 : Number(seat) === 1 ? 1 : 0;
      if (n === this.seat) return;
      this.seat = n;
      if (this.layout === 'auto') this._recomputeKeyboard(false);
      this._emit(true);
    }

    setLayout(layout) {
      const next = layout === 'p1' || layout === 'p2' ? layout : 'auto';
      if (next === this.layout) return;
      this.layout = next;
      this._recomputeKeyboard(false);
      this._emit(true);
    }

    setPadSlot(slot) {
      const n = Number(slot);
      const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      if (next === this.padSlot) return;
      this.padSlot = next;
      this.padKey = '';
      this.padHeld = createHeld();
      this._updatePadStatus(true);
      this._emit(true);
    }

    setTouchVisible(visible) {
      const next = !!visible;
      this._bindTouch();
      this.touchVisible = next;
      document.body.classList.toggle('touch', next);
      const el = document.getElementById('touchControls');
      if (el) el.hidden = !next;
      const btn = document.getElementById('btnTouch');
      if (btn) btn.classList.toggle('active', next);
      if (!next) {
        this.touchPointers.clear();
        this.touchMask = 0;
        this._clearTouchClasses();
        this._emit();
      }
    }

    toggleTouch() {
      this.setTouchVisible(!this.touchVisible);
      return this.touchVisible;
    }

    getMask() {
      // The native PSX pad word is active-low: 0 = pressed, 1 = released.
      return (~(this.keyboardMask | this.gamepadMask | this.touchMask)) & 0xFFFF;
    }

    getPadInfo() { return this.padInfo; }

    rumble(duration = 350, strong = 0.9, weak = 0.6) {
      const ok = this._rumblePad(this._selectedPad(), duration, strong, weak);
      this.onRumble(ok);
      return ok;
    }

    _rumblePad(pad, duration, strong, weak) {
      if (!pad) return false;
      const ms = Math.max(50, Number(duration) || 350);
      const s = clamp(Number(strong) || 0, 0, 1);
      const w = clamp(Number(weak) || 0, 0, 1);
      const actuators = [];
      if (pad.vibrationActuator) actuators.push(pad.vibrationActuator);
      if (Array.isArray(pad.hapticActuators)) {
        for (const act of pad.hapticActuators) if (act) actuators.push(act);
      }

      for (const act of actuators) {
        if (typeof act.playEffect !== 'function') continue;
        try {
          const result = act.playEffect('dual-rumble', {
            duration: ms,
            startDelay: 0,
            strongMagnitude: s,
            weakMagnitude: w,
          });
          if (result && typeof result.catch === 'function') result.catch(() => {});
          return true;
        } catch { /* try the next actuator */ }
      }
      for (const act of actuators) {
        if (typeof act.pulse !== 'function') continue;
        try {
          const result = act.pulse(s, ms);
          if (result && typeof result.catch === 'function') result.catch(() => {});
          return true;
        } catch { /* try the next actuator */ }
      }
      return false;
    }

    releaseAll() {
      this._releaseInputs(true);
    }

    _releaseInputs(force) {
      this.keys.clear();
      this.keyboardMask = 0;
      this.gamepadMask = 0;
      this.touchPointers.clear();
      this.touchMask = 0;
      this.padHeld = createHeld();
      this._clearTouchClasses();
      this._emit(force);
    }

    // ---- keyboard ----
    _layoutKeys() {
      if (this.layout === 'p1') return P1_KEYS;
      if (this.layout === 'p2') return P2_KEYS;
      return this.seat === 2 ? P2_KEYS : P1_KEYS;
    }

    _isTyping(target) {
      if (!target) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
    }

    _keydown(e) {
      if (this._isTyping(e.target) || this._isTyping(document.activeElement)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const map = this._layoutKeys();
      const bit = map[e.code];
      if (!bit) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      this.keys.add(e.code);
      this._recomputeKeyboard();
    }

    _keyup(e) {
      // Always release a key we saw pressed, even if focus moved into a text
      // field while it was held.
      if (!this.keys.has(e.code)) return;
      this.keys.delete(e.code);
      if (!this._isTyping(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      this._recomputeKeyboard();
    }

    _recomputeKeyboard(emit = true) {
      const map = this._layoutKeys();
      let mask = 0;
      for (const code of this.keys) {
        const bit = map[code];
        if (bit) mask |= bit;
      }
      this.keyboardMask = mask;
      if (emit) this._emit();
    }

    _blur() {
      this._releaseInputs(true);
    }

    _onVisibility() {
      if (document.hidden) this._releaseInputs(true);
    }

    _onPageHide() {
      this._releaseInputs(true);
    }

    // ---- gamepad ----
    _onConnected() {
      this.padKey = '';
      this.padHeld = createHeld();
      this._updatePadStatus(true);
      this._emit(true);
    }

    _onDisconnected() {
      this.padKey = '';
      this.padHeld = createHeld();
      this.gamepadMask = 0;
      this._updatePadStatus(true);
      this._emit(true);
    }

    _connectedPads() {
      let pads;
      try {
        pads = navigator.getGamepads ? navigator.getGamepads() : [];
      } catch {
        return [];
      }
      const out = [];
      if (!pads) return out;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) out.push(p);
      }
      return out;
    }

    _pickPad(pads) {
      if (!pads || !pads.length) return null;
      return pads[this.padSlot] || pads[0];
    }

    _selectedPad() {
      return this._pickPad(this._connectedPads());
    }

    _updatePadStatus(force = false, pad) {
      const selected = pad === undefined ? this._selectedPad() : pad;
      let info;
      if (!selected) {
        info = { connected: false, name: '', type: 'generic', mapping: '', index: -1 };
      } else {
        const type = detectPadType(selected.id);
        info = {
          connected: true,
          name: cleanPadName(selected.id, type),
          fullId: selected.id,
          type,
          mapping: selected.mapping || 'non-standard',
          index: selected.index,
          buttons: selected.buttons ? selected.buttons.length : 0,
          axes: selected.axes ? selected.axes.length : 0,
        };
      }
      const key = JSON.stringify(info);
      if (force || key !== this.padInfoKey) {
        this.padInfoKey = key;
        this.padInfo = info;
        this.onPadStatus(info);
      }
    }

    _poll() {
      this.raf = requestAnimationFrame(this._poll);
      if (document.hidden) {
        if (this.keyboardMask || this.gamepadMask || this.touchMask) this._releaseInputs(true);
        return;
      }

      const pads = this._connectedPads();
      const pad = this._pickPad(pads);
      const key = pad ? `${pad.index}|${pad.id}` : '';
      if (key !== this.padKey) {
        this.padKey = key;
        this.padHeld = createHeld();
      }
      this._updatePadStatus(false, pad);

      if (!pad) {
        if (this.gamepadMask) {
          this.gamepadMask = 0;
          this._emit();
        }
        return;
      }

      const result = mapStandardPad(pad, this.padHeld);
      this.padHeld = result.held;
      if (result.mask !== this.gamepadMask) {
        this.gamepadMask = result.mask;
        this._emit();
      }
    }

    // ---- touch ----
    _bindTouch() {
      if (this._touchBound) return;
      const root = document.getElementById('touchControls');
      if (!root) return;
      this._touchRoot = root;
      this._touchBound = true;
      root.addEventListener('pointerdown', this._touchDown, { passive: false });
      root.addEventListener('contextmenu', this._touchContext);
      window.addEventListener('pointerup', this._touchUp);
      window.addEventListener('pointercancel', this._touchUp);
      window.addEventListener('lostpointercapture', this._touchUp);
    }

    _touchDown(e) {
      const root = this._touchRoot;
      if (!root) return;
      const btn = e.target && e.target.closest ? e.target.closest('[data-touch]') : null;
      if (!btn || !root.contains(btn)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const bit = TOUCH_BITS[btn.dataset.touch];
      if (!bit) return;
      e.preventDefault();
      this.touchPointers.set(e.pointerId, { bit, el: btn });
      btn.classList.add('on');
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this._recomputeTouch();
    }

    _touchUp(e) {
      const rec = this.touchPointers.get(e.pointerId);
      if (!rec) return;
      this.touchPointers.delete(e.pointerId);
      let stillDown = false;
      for (const other of this.touchPointers.values()) {
        if (other.el === rec.el) { stillDown = true; break; }
      }
      if (!stillDown) rec.el.classList.remove('on');
      this._recomputeTouch();
    }

    _touchContext(e) {
      e.preventDefault();
    }

    _recomputeTouch() {
      let mask = 0;
      for (const rec of this.touchPointers.values()) mask |= rec.bit;
      this.touchMask = mask;
      this._emit();
    }

    _clearTouchClasses() {
      if (!this._touchRoot) return;
      for (const el of this._touchRoot.querySelectorAll('[data-touch].on')) {
        el.classList.remove('on');
      }
    }

    // ---- change ----
    _emit(force = false) {
      const mask = this.getMask();
      if (force || mask !== this.lastMask) {
        this.lastMask = mask;
        this.onChange(mask);
      }
    }
  }

  // Public API used by app.js.  The two helpers are exposed for debugging and
  // tests without changing the enumerable shape of the object.
  const api = { InputController, BIT, NEUTRAL, detectPadType, padLabel };
  Object.defineProperties(api, {
    mapStandardPad: { value: mapStandardPad, enumerable: false },
    resolveLayout: { value: resolveLayout, enumerable: false },
  });
  window.RR4Input = api;
})();
