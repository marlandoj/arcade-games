/**
 * OpenFlight Sim — Audio (T4, OFS-004).
 *
 * Contract (frozen at T1): `createAudio()` returns a handle the orchestrator
 * drives each render via `update(sim)`, unlocked on first user gesture via
 * `init()` / `resume()`, with `setMuted`, `isMuted`, `isRunning`, `dispose`.
 *
 * Everything here is WebAudio-synthesised — there are no audio files:
 *   • engine tone whose fundamental tracks RPM (prop) or N1 (jet), with a couple
 *     of harmonics and a jet whine blended in for the light jet;
 *   • airflow / wind noise (a filtered noise bed) whose level tracks airspeed;
 *   • a pulsing stall-warning horn while `sim.stalled`;
 *   • a gear-transit servo whir on gear up/down transitions;
 *   • a touchdown thump when weight settles onto the wheels.
 *
 * The engine and airflow voices run continuously and are re-parameterised each
 * frame; the cues are one-shot voices spawned on state transitions. Audio reads
 * `sim` only. Degrades to a silent no-op where WebAudio is unavailable.
 */

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let started = false;

  // Continuous voices.
  let engine = null; // { osc1, osc2, gain, filter, jet, jetGain }
  let airflow = null; // { src, filter, gain }
  let stall = null; // { osc, gain } — level pulsed while stalled

  // Transition trackers.
  let prevGear = null;
  let prevOnGround = null;
  let prevAirspeed = 0;
  let noiseBuffer = null;

  const BASE_GAIN = 0.5;

  function ensure() {
    if (ctx) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : BASE_GAIN;
      master.connect(ctx.destination);
      noiseBuffer = makeNoiseBuffer(ctx);
      buildEngine();
      buildAirflow();
      buildStall();
    } catch {
      ctx = null;
    }
  }

  function buildEngine() {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    const osc1 = ctx.createOscillator();
    osc1.type = "sawtooth";
    const osc2 = ctx.createOscillator();
    osc2.type = "square";
    const o2Gain = ctx.createGain();
    o2Gain.gain.value = 0.4;
    // Jet whine — a higher sine that fades in for the jet only.
    const jet = ctx.createOscillator();
    jet.type = "sine";
    const jetGain = ctx.createGain();
    jetGain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(o2Gain).connect(filter);
    jet.connect(jetGain).connect(filter);
    filter.connect(gain).connect(master);
    osc1.start();
    osc2.start();
    jet.start();
    engine = { osc1, osc2, gain, filter, jet, jetGain };
  }

  function buildAirflow() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 500;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    airflow = { src, filter, gain };
  }

  function buildStall() {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(master);
    osc.start();
    stall = { osc, gain };
  }

  function update(sim) {
    if (!ctx || !started) return;
    const now = ctx.currentTime;
    if (muted) {
      // Hold everything down while muted; still track transitions silently.
      prevGear = sim.gear;
      prevOnGround = !!sim.onGround;
      prevAirspeed = sim.airspeed || 0;
      return;
    }
    const flying = sim.screen === "flying" || sim.screen === "paused";
    const rpm = clamp01(sim.rpm || 0);
    const isJet = sim.airframe === "jet";

    // ── Engine: fundamental tracks RPM/N1 ────────────────────────────────
    if (engine) {
      const f0 = isJet ? 90 + rpm * 260 : 55 + rpm * 150;
      engine.osc1.frequency.setTargetAtTime(f0, now, 0.08);
      engine.osc2.frequency.setTargetAtTime(f0 * 2, now, 0.08);
      engine.jet.frequency.setTargetAtTime(600 + rpm * 2600, now, 0.1);
      engine.jetGain.gain.setTargetAtTime(isJet ? 0.06 + rpm * 0.12 : 0.0, now, 0.15);
      engine.filter.frequency.setTargetAtTime(700 + rpm * 2200, now, 0.1);
      const lvl = flying ? 0.12 + rpm * 0.30 : 0.0;
      engine.gain.gain.setTargetAtTime(lvl, now, 0.1);
    }

    // ── Airflow: bandpass noise, level and brightness track airspeed ─────
    if (airflow) {
      const kt = (sim.airspeed || 0) * 1.94384;
      const norm = clamp01(kt / 200);
      airflow.gain.gain.setTargetAtTime(flying ? norm * norm * 0.28 : 0, now, 0.12);
      airflow.filter.frequency.setTargetAtTime(300 + norm * 1400, now, 0.12);
    }

    // ── Stall warning: pulsing horn while stalled and airborne ───────────
    if (stall) {
      const warn = flying && !!sim.stalled && !sim.onGround;
      // ~6.5 Hz pulse from a phase built off sim time (deterministic-ish).
      const pulse = warn ? (Math.sin((sim.t || 0) * 2 * Math.PI * 6.5) > 0 ? 1 : 0) : 0;
      stall.gain.gain.setTargetAtTime(pulse * 0.18, now, 0.01);
    }

    // ── One-shot cues on transitions ─────────────────────────────────────
    if (prevGear != null && sim.gear !== prevGear) gearTransit();
    const onGround = !!sim.onGround;
    if (prevOnGround === false && onGround) {
      // Weight settled onto the wheels — thump scaled by descent rate.
      const vsAbs = Math.abs(sim.verticalSpeed || 0);
      touchdown(clamp01(vsAbs / 4));
    }
    prevGear = sim.gear;
    prevOnGround = onGround;
    prevAirspeed = sim.airspeed || 0;
  }

  function gearTransit() {
    if (!ctx || muted) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(220, now);
    filter.frequency.linearRampToValueAtTime(520, now + 1.2);
    filter.Q.value = 5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.08);
    gain.gain.setValueAtTime(0.16, now + 1.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    src.connect(filter).connect(gain).connect(master);
    src.start(now);
    src.stop(now + 1.45);
  }

  function touchdown(intensity) {
    if (!ctx || muted) return;
    const now = ctx.currentTime;
    // Low thump: a fast-decaying sine dropping in pitch.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.22);
    const oGain = ctx.createGain();
    const peak = 0.18 + intensity * 0.5;
    oGain.gain.setValueAtTime(peak, now);
    oGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(oGain).connect(master);
    osc.start(now);
    osc.stop(now + 0.4);
    // Tyre chirp: a short noise burst layered on top.
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 1200;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.12 + intensity * 0.2, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    src.connect(filter).connect(nGain).connect(master);
    src.start(now);
    src.stop(now + 0.2);
  }

  return {
    init() {
      ensure();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      started = true;
    },
    resume() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); },
    update,
    setMuted(m) {
      muted = !!m;
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : BASE_GAIN, ctx.currentTime, 0.04);
    },
    isMuted() { return muted; },
    isRunning() { return started && !!ctx; },
    dispose() {
      try {
        for (const v of [engine, airflow, stall]) {
          if (!v) continue;
          for (const n of [v.osc1, v.osc2, v.jet, v.osc, v.src]) {
            try { if (n && n.stop) n.stop(); } catch {}
          }
        }
        if (ctx) ctx.close();
      } catch {}
      ctx = null; master = null; engine = null; airflow = null; stall = null;
    },
  };
}

function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export const __OFS_BOUNDARY__ = "audio";
