/**
 * OpenFlight Sim — Audio (T1 boundary stub, OFS-004 fills).
 *
 * Contract: `createAudio()` returns a handle the orchestrator drives each
 * render via `update(sim)` and unlocks on first user gesture via `init()` /
 * `resume()`. T4 replaces the no-op with a WebAudio synth: engine tone
 * tracking RPM/N1, airflow noise tracking airspeed, stall warning, gear
 * transit and touchdown cues — no audio files. The call sites here are frozen.
 */

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let started = false;

  function ensure() {
    if (ctx) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
    }
  }

  return {
    init() { ensure(); if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); started = true; },
    resume() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); },
    update(sim) {
      if (!ctx || muted || !started) return;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
    },
    setMuted(m) {
      muted = !!m;
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
    },
    isMuted() { return muted; },
    isRunning() { return started && !!ctx; },
    dispose() {
      try { if (ctx) ctx.close(); } catch {}
      ctx = null; master = null;
    },
  };
}

export const __OFS_BOUNDARY__ = "audio";
