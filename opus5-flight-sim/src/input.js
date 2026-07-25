/**
 * Unified control input: keyboard, mouse yoke (pointer lock), gamepad, and
 * on-screen touch controls. Produces a single normalised axis set plus a
 * queue of discrete commands the sim drains each frame.
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const KEYMAP = [
  ['W / S  or  ↑ / ↓', 'Elevator (stick fore / aft)'],
  ['A / D  or  ← / →', 'Ailerons'],
  ['Q / E', 'Rudder'],
  ['Shift / Ctrl', 'Throttle up / down'],
  ['F  /  Shift+F', 'Flaps down / up'],
  ['G', 'Landing gear'],
  ['Space', 'Wheel brakes  •  B: park brake'],
  ['[  /  ]', 'Elevator trim'],
  ['V', 'Cycle view'],
  ['H  /  N', 'HUD  /  nav display'],
  ['L  /  M', 'Landing light  /  mute'],
  ['P  or  Esc', 'Pause'],
  ['R', 'Reset flight'],
];

export class Input {
  constructor(opts = {}) {
    this.axes = { pitch: 0, roll: 0, yaw: 0 };
    this.throttle = 0;
    this.brake = 0;
    this.parkBrake = true;
    this.commands = [];
    this.mouseYoke = false;
    this.invertPitch = false;
    this.pointerLocked = false;
    this.active = 'key';
    this.keys = new Set();
    this.touch = { stickX: 0, stickY: 0, throttle: null, brake: 0, active: false };
    this.gamepadIndex = null;
    this.enabled = true;
    this.canvas = opts.canvas || null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.mouseYoke = false;
    });
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  cmd(name) { this.commands.push(name); }
  drain() { const c = this.commands; this.commands = []; return c; }

  _onKeyDown(e) {
    if (e.repeat) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.add(k);
    if (e.code === 'Space') this.keys.add(' ');
    const block = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'];
    if (block.includes(k) || e.code === 'Space') e.preventDefault();
    if (!this.enabled) {
      if (k === 'Escape' || k === 'p') this.cmd('pause');
      return;
    }
    this.active = 'key';
    switch (k) {
      case 'f': this.cmd(e.shiftKey ? 'flapsUp' : 'flapsDown'); break;
      case 'g': this.cmd('gear'); break;
      case 'b': this.cmd('parkBrake'); break;
      case 'v': this.cmd('view'); break;
      case 'h': this.cmd('hud'); break;
      case 'n': this.cmd('nav'); break;
      case 'l': this.cmd('light'); break;
      case 'm': this.cmd('mute'); break;
      case 'r': this.cmd('reset'); break;
      case 'y': this.cmd('yoke'); break;
      case 'p': case 'Escape': this.cmd('pause'); break;
      default: break;
    }
  }

  _onKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(k);
    if (e.code === 'Space') this.keys.delete(' ');
  }

  _onMouseMove(e) {
    if (!this.mouseYoke || !this.pointerLocked || !this.enabled) return;
    this.active = 'mouse';
    const s = 0.0042;
    this.axes.roll = clamp(this.axes.roll + e.movementX * s, -1, 1);
    this.axes.pitch = clamp(this.axes.pitch + e.movementY * s * (this.invertPitch ? -1 : 1), -1, 1);
  }

  requestYoke(canvas) {
    this.canvas = canvas;
    this.mouseYoke = true;
    canvas.requestPointerLock?.();
  }

  releaseYoke() {
    this.mouseYoke = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* ---------------- touch ---------------- */

  bindTouch(stickEl, knobEl, thrEl, thrKnobEl) {
    const rectOf = (el) => el.getBoundingClientRect();

    const stickMove = (e) => {
      const r = rectOf(stickEl);
      const t = e.touches ? e.touches[0] : e;
      const dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const m = Math.max(1, Math.hypot(dx, dy));
      this.touch.stickX = clamp(dx / m, -1, 1);
      this.touch.stickY = clamp(dy / m, -1, 1);
      this.touch.active = true;
      this.active = 'touch';
      knobEl.style.transform = `translate(${this.touch.stickX * r.width * 0.32}px, ${this.touch.stickY * r.height * 0.32}px)`;
    };
    const stickEnd = () => {
      this.touch.stickX = 0; this.touch.stickY = 0; this.touch.active = false;
      knobEl.style.transform = 'translate(0,0)';
    };
    stickEl.addEventListener('touchstart', (e) => { e.preventDefault(); stickMove(e); }, { passive: false });
    stickEl.addEventListener('touchmove', (e) => { e.preventDefault(); stickMove(e); }, { passive: false });
    stickEl.addEventListener('touchend', stickEnd);
    stickEl.addEventListener('touchcancel', stickEnd);
    stickEl.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') { stickEl.setPointerCapture(e.pointerId); stickMove(e); } });
    stickEl.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch' && e.buttons) stickMove(e); });
    stickEl.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') stickEnd(); });

    const thrMove = (e) => {
      const r = rectOf(thrEl);
      const t = e.touches ? e.touches[0] : e;
      const v = 1 - clamp((t.clientY - r.top) / r.height, 0, 1);
      this.touch.throttle = v;
      this.active = 'touch';
      thrKnobEl.style.bottom = `${v * 100}%`;
    };
    thrEl.addEventListener('touchstart', (e) => { e.preventDefault(); thrMove(e); }, { passive: false });
    thrEl.addEventListener('touchmove', (e) => { e.preventDefault(); thrMove(e); }, { passive: false });
    thrEl.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') { thrEl.setPointerCapture(e.pointerId); thrMove(e); } });
    thrEl.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch' && e.buttons) thrMove(e); });
  }

  bindHold(el, onDown, onUp) {
    const down = (e) => { e.preventDefault(); onDown(); };
    const up = (e) => { e.preventDefault(); onUp && onUp(); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('mousedown', down);
    window.addEventListener('mouseup', () => onUp && onUp());
  }

  /* ---------------- per-frame ---------------- */

  update(dt) {
    if (!this.enabled) {
      this.axes.pitch = this.axes.roll = this.axes.yaw = 0;
      this.brake = 0;
      return;
    }
    const K = this.keys;
    const rate = 2.9, center = 3.4;

    // Keyboard axes with spring return
    let kp = 0, kr = 0, ky = 0;
    if (K.has('w') || K.has('ArrowUp')) kp -= 1;
    if (K.has('s') || K.has('ArrowDown')) kp += 1;
    if (K.has('a') || K.has('ArrowLeft')) kr -= 1;
    if (K.has('d') || K.has('ArrowRight')) kr += 1;
    if (K.has('q')) ky -= 1;
    if (K.has('e')) ky += 1;
    if (this.invertPitch) kp = -kp;

    const step = (cur, target) => {
      if (target !== 0) return clamp(cur + target * rate * dt, -1, 1);
      const d = center * dt;
      return Math.abs(cur) <= d ? 0 : cur - Math.sign(cur) * d;
    };

    if (this.active !== 'mouse' || (kp || kr || ky)) {
      if (kp || this.active === 'key') this.axes.pitch = step(this.axes.pitch, kp);
      if (kr || this.active === 'key') this.axes.roll = step(this.axes.roll, kr);
    }
    this.axes.yaw = step(this.axes.yaw, ky);

    // Throttle
    let dth = 0;
    if (K.has('Shift') || K.has('=') || K.has('+')) dth += 1;
    if (K.has('Control') || K.has('-') || K.has('_')) dth -= 1;
    if (dth) { this.throttle = clamp(this.throttle + dth * dt * 0.55, 0, 1); this.active = 'key'; }

    // Brakes
    this.brake = K.has(' ') ? 1 : 0;

    // Trim
    if (K.has('[')) this.cmd('trimDown');
    if (K.has(']')) this.cmd('trimUp');

    /* --- touch overrides --- */
    if (this.touch.active) {
      this.axes.roll = this.touch.stickX;
      this.axes.pitch = this.touch.stickY * (this.invertPitch ? -1 : 1);
    }
    if (this.touch.throttle !== null) this.throttle = this.touch.throttle;
    if (this.touch.brake) this.brake = 1;

    /* --- gamepad --- */
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = this.gamepadIndex !== null ? pads[this.gamepadIndex] : (pads && pads[0]);
    if (gp && gp.connected) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = dz(gp.axes[0] ?? 0), ay = dz(gp.axes[1] ?? 0);
      const rx = dz(gp.axes[2] ?? 0);
      if (ax || ay) {
        this.axes.roll = ax;
        this.axes.pitch = ay * (this.invertPitch ? -1 : 1);
        this.active = 'pad';
      }
      if (rx) this.axes.yaw = rx;
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      if (rt > 0.03 || lt > 0.03) { this.throttle = clamp(this.throttle + (rt - lt) * dt * 0.9, 0, 1); this.active = 'pad'; }
      this._padEdge = this._padEdge || {};
      const press = (i, name) => {
        const on = !!gp.buttons[i]?.pressed;
        if (on && !this._padEdge[i]) this.cmd(name);
        this._padEdge[i] = on;
      };
      press(0, 'flapsDown'); press(1, 'gear'); press(3, 'view'); press(9, 'pause');
      if (gp.buttons[2]?.pressed) this.brake = 1;
    }
  }
}
