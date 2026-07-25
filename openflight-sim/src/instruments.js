/**
 * OpenFlight Sim — Instruments, HUD, panel (T1 boundary stub, OFS-004 fills).
 *
 * Contract: `createInstruments(root)` mounts the cockpit readouts into `root`
 * (an HTMLElement overlay) and returns `{ update(sim), setHudVisible(v),
 * setPanelVisible(v) }`. The orchestrator calls `update(sim)` each render.
 * T4 replaces this text stub with the analog six-pack (ASI, AI, ALT, TC, HI,
 * VSI), tach/N1, fuel/flap/gear, and a HUD overlay with a flight-path marker.
 * The call sites here are frozen.
 */

export function createInstruments(root) {
  const hud = document.createElement("div");
  hud.className = "ofs-hud";
  hud.innerHTML = `
    <div class="ofs-hud-row"><span>SPD</span><b data-spd>000</b><span>kt</span></div>
    <div class="ofs-hud-row"><span>ALT</span><b data-alt>0000</b><span>ft</span></div>
    <div class="ofs-hud-row"><span>HDG</span><b data-hdg>000</b><span>°</span></div>
    <div class="ofs-hud-row"><span>V/S</span><b data-vs>0</b><span>fpm</span></div>
    <div class="ofs-hud-row"><span>RPM</span><b data-rpm>0</b><span>%</span></div>
  `;
  const panel = document.createElement("div");
  panel.className = "ofs-panel";
  panel.innerHTML = `
    <div class="ofs-panel-row"><span>THROTTLE</span><div class="ofs-bar"><i data-thr></i></div></div>
    <div class="ofs-panel-row"><span>FUEL</span><div class="ofs-bar"><i data-fuel></i></div></div>
    <div class="ofs-panel-row"><span>GEAR</span><b data-gear>DOWN</b></div>
    <div class="ofs-panel-row"><span>FLAPS</span><b data-flaps>0</b></div>
  `;
  root.appendChild(hud);
  root.appendChild(panel);

  const el = {
    spd: hud.querySelector("[data-spd]"),
    alt: hud.querySelector("[data-alt]"),
    hdg: hud.querySelector("[data-hdg]"),
    vs: hud.querySelector("[data-vs]"),
    rpm: hud.querySelector("[data-rpm]"),
    thr: panel.querySelector("[data-thr]"),
    fuel: panel.querySelector("[data-fuel]"),
    gear: panel.querySelector("[data-gear]"),
    flaps: panel.querySelector("[data-flaps]"),
  };

  let hudVisible = true;
  let panelVisible = true;

  return {
    update(sim) {
      const kt = sim.airspeed * 1.94384;
      const ft = sim.altitude * 3.28084;
      const hdgDeg = ((sim.heading * 180 / Math.PI) % 360 + 360) % 360;
      const fpm = sim.verticalSpeed * 196.85;
      el.spd.textContent = pad3(Math.round(kt));
      el.alt.textContent = pad4(Math.round(ft));
      el.hdg.textContent = pad3(Math.round(hdgDeg));
      el.vs.textContent = (fpm >= 0 ? "+" : "") + Math.round(fpm);
      el.rpm.textContent = Math.round((sim.rpm || 0) * 100);
      // Read display state from the live sim object (ZOU-920 remediation #9),
      // not from sim.controls which is replaced wholesale each fixed step.
      el.thr.style.width = pct(sim.throttle);
      el.fuel.style.width = pct(sim.fuel);
      el.gear.textContent = sim.gear ? "DOWN" : "UP";
      el.flaps.textContent = (sim.flaps || 0).toFixed(0);
    },
    setHudVisible(v) { hudVisible = !!v; hud.style.display = v ? "" : "none"; },
    setPanelVisible(v) { panelVisible = !!v; panel.style.display = v ? "" : "none"; },
    isHudVisible() { return hudVisible; },
    isPanelVisible() { return panelVisible; },
    dispose() { root.removeChild(hud); root.removeChild(panel); },
  };
}

function pad3(n) { return String(Math.max(0, n)).padStart(3, "0"); }
function pad4(n) { return String(Math.max(0, n)).padStart(4, "0"); }
function pct(v) { return Math.max(0, Math.min(1, v || 0)) * 100 + "%"; }

export const __OFS_BOUNDARY__ = "instruments";
