/**
 * Web Audio engine. Everything is synthesised — no external files.
 *
 *  - piston: firing-order harmonic stack driven by RPM, plus prop blade tone
 *  - turbofan: broadband core noise + N1 fan whine + compressor buzz
 *  - airframe: filtered noise scaled by dynamic pressure
 *  - ground: rolling rumble whose brightness tracks surface and speed
 *  - warnings: stall horn, gear/overspeed tone, touchdown thump
 */

export class SimAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.type = 'piston';
  }

  init(type) {
    if (this.ready) { this.setType(type); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // Shared noise source
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = w * 0.55 + last * 3.2;
    }
    this.noiseBuf = buf;

    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.loop = true; s.start();
      return s;
    };

    /* --- engine bus --- */
    this.engBus = ctx.createGain();
    this.engBus.gain.value = 0;
    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = 'lowpass';
    this.engLP.frequency.value = 1400;
    this.engBus.connect(this.engLP).connect(this.master);

    // Piston harmonics
    this.oscs = [];
    const harm = [1, 2, 3, 4.5];
    const amp = [0.55, 0.34, 0.20, 0.10];
    for (let i = 0; i < harm.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'square';
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = amp[i];
      o.connect(g).connect(this.engBus);
      o.start();
      this.oscs.push({ o, g, h: harm[i] });
    }
    // Combustion roughness
    this.engNoise = noise();
    this.engNoiseBP = ctx.createBiquadFilter();
    this.engNoiseBP.type = 'bandpass';
    this.engNoiseBP.frequency.value = 320;
    this.engNoiseBP.Q.value = 0.7;
    this.engNoiseG = ctx.createGain();
    this.engNoiseG.gain.value = 0.35;
    this.engNoise.connect(this.engNoiseBP).connect(this.engNoiseG).connect(this.engBus);

    // Turbofan fan whine
    this.fan = ctx.createOscillator();
    this.fan.type = 'sine';
    this.fan.frequency.value = 400;
    this.fanG = ctx.createGain();
    this.fanG.gain.value = 0;
    this.fan.connect(this.fanG).connect(this.engBus);
    this.fan.start();
    this.buzz = ctx.createOscillator();
    this.buzz.type = 'sawtooth';
    this.buzz.frequency.value = 1200;
    this.buzzG = ctx.createGain();
    this.buzzG.gain.value = 0;
    this.buzz.connect(this.buzzG).connect(this.engBus);
    this.buzz.start();

    /* --- airframe wind --- */
    this.wind = noise();
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = 'bandpass';
    this.windBP.frequency.value = 700;
    this.windBP.Q.value = 0.45;
    this.windG = ctx.createGain();
    this.windG.gain.value = 0;
    this.wind.connect(this.windBP).connect(this.windG).connect(this.master);

    /* --- ground rumble --- */
    this.roll = noise();
    this.rollLP = ctx.createBiquadFilter();
    this.rollLP.type = 'lowpass';
    this.rollLP.frequency.value = 180;
    this.rollG = ctx.createGain();
    this.rollG.gain.value = 0;
    this.roll.connect(this.rollLP).connect(this.rollG).connect(this.master);

    /* --- stall horn --- */
    this.horn = ctx.createOscillator();
    this.horn.type = 'square';
    this.horn.frequency.value = 760;
    this.hornG = ctx.createGain();
    this.hornG.gain.value = 0;
    const hornLP = ctx.createBiquadFilter();
    hornLP.type = 'lowpass'; hornLP.frequency.value = 2600;
    this.horn.connect(this.hornG).connect(hornLP).connect(this.master);
    this.horn.start();

    /* --- warning tone --- */
    this.warn = ctx.createOscillator();
    this.warn.type = 'sine';
    this.warn.frequency.value = 980;
    this.warnG = ctx.createGain();
    this.warnG.gain.value = 0;
    this.warn.connect(this.warnG).connect(this.master);
    this.warn.start();

    this.ready = true;
    this.setType(type);
  }

  setType(type) {
    this.type = type;
    if (!this.ready) return;
    const jet = type === 'turbofan';
    for (const h of this.oscs) h.g.gain.value = jet ? 0 : h.g.gain.value || 0.2;
    this.engNoiseG.gain.value = jet ? 0.9 : 0.35;
    this.engLP.frequency.value = jet ? 3200 : 1400;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  /**
   * @param {object} s { rpm, rpmMax, throttle, running, ias, onGround,
   *                     groundSpeed, paved, stall, warn, jet }
   */
  update(s) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = 0.06;

    if (s.jet) {
      const n1 = Math.max(0, s.rpm) / 100;
      this.fanG.gain.setTargetAtTime(n1 * 0.16, t, k);
      this.fan.frequency.setTargetAtTime(180 + n1 * 1500, t, k);
      this.buzzG.gain.setTargetAtTime(Math.pow(n1, 2.2) * 0.05, t, k);
      this.buzz.frequency.setTargetAtTime(600 + n1 * 2600, t, k);
      this.engBus.gain.setTargetAtTime(0.12 + n1 * 0.55, t, k);
      this.engNoiseBP.frequency.setTargetAtTime(240 + n1 * 900, t, k);
      for (const h of this.oscs) h.g.gain.setTargetAtTime(0, t, k);
    } else {
      const firing = (Math.max(0, s.rpm) / 60) * 2; // 4-cyl, 4-stroke
      for (const h of this.oscs) {
        h.o.frequency.setTargetAtTime(Math.max(8, firing * h.h), t, k);
      }
      const load = 0.30 + s.throttle * 0.70;
      const on = s.running ? 1 : 0.12;
      this.engBus.gain.setTargetAtTime((0.10 + load * 0.62) * on * Math.min(1, s.rpm / 600), t, k);
      this.engLP.frequency.setTargetAtTime(700 + s.throttle * 2200, t, k);
      this.engNoiseBP.frequency.setTargetAtTime(180 + firing * 2.5, t, k);
      this.fanG.gain.setTargetAtTime(0, t, k);
      this.buzzG.gain.setTargetAtTime(0, t, k);
      for (const h of this.oscs) {
        const amp = [0.55, 0.34, 0.20, 0.10][this.oscs.indexOf(h)] ?? 0.15;
        h.g.gain.setTargetAtTime(amp, t, k);
      }
    }

    // Airframe noise ~ dynamic pressure
    const q = Math.min(1.4, Math.pow(s.ias / 70, 2));
    this.windG.gain.setTargetAtTime(q * 0.30, t, k);
    this.windBP.frequency.setTargetAtTime(420 + s.ias * 9, t, k);

    // Ground roll
    const gr = s.onGround ? Math.min(1, s.groundSpeed / 40) : 0;
    this.rollG.gain.setTargetAtTime(gr * (s.paved ? 0.28 : 0.46), t, 0.04);
    this.rollLP.frequency.setTargetAtTime(90 + s.groundSpeed * (s.paved ? 5 : 11), t, 0.05);

    // Stall horn: intermittent as the buffet builds
    const stallOn = s.stall > 0.32;
    const pulse = stallOn ? (Math.sin(t * 22) > -0.2 ? 1 : 0.15) : 0;
    this.hornG.gain.setTargetAtTime(pulse * 0.11 * Math.min(1, s.stall * 1.6), t, 0.02);

    // Master warning
    const warnOn = s.warn ? (Math.sin(t * 12) > 0 ? 1 : 0) : 0;
    this.warnG.gain.setTargetAtTime(warnOn * 0.07, t, 0.02);
  }

  /** One-shot impact/thump. */
  thump(strength = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.35 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(70, t + 0.32);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.95, 0.22 + strength * 0.5), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    s.connect(f).connect(g).connect(this.master);
    s.start(t); s.stop(t + 0.5);
  }

  /** Short mechanical click (gear/flap detent, switch). */
  click(freq = 380, dur = 0.07, vol = 0.10) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /** Rising or falling UI chirp. */
  chirp(up = true) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(up ? 520 : 900, t);
    o.frequency.exponentialRampToValueAtTime(up ? 1050 : 380, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.25);
  }
}
