# Zouroboros Arcade

A registry-driven HTML5 arcade hub. Add a game by dropping a directory and one entry in `registry.json` — no build step, no server-side runtime.

**Live:** https://zouroboros-arcade-marlandoj.zocomputer.io

## Games

| ID | Title | Features |
|----|-------|----------|
| `sol-racer` | **Sol Racer** — Cel-Shaded Solar Ocean Racing | Deterministic 60 Hz race simulation, 4 boats, 3 laps, ordered checkpoints, procedural Gerstner ocean, buoyancy and drift boosts, 3 AI personalities, articulated riders, synthesized audio, keyboard/gamepad/touch controls |
| `vyon-boat-racer` | **Vyon Boat Racer** — Cel-Shaded Ocean Racing | Deterministic fixed-step race simulation, 4 boats, 3 laps, ordered checkpoints, procedural cel-shaded water, wave buoyancy, drift boosts, synthesized audio, keyboard/gamepad controls |
| `iron-meridian` | **Iron Meridian** — Arena FPS | Deterministic combat, pathfinding bots, 3 weapons, pickups, pooled effects, procedural audio, full HUD, 529 tests and 18 browser scenarios |
| `openflight-sim` | **OpenFlight Sim** — Study-Level Browser Flight | Fixed-step 6-DOF rigid body, ISA atmosphere + wind/gust/turbulence, spring-damper gear, 3 airframes, procedural terrain + PAPI, analog six-pack + glass HUD, 4 scored missions, graded landings |
| `opus5-flight-sim` | **Opus 5 Flight Sim** — Six Degrees of Freedom | 6-DOF rigid-body aerodynamics, ISA atmosphere, wind/gust/turbulence, 3 airframes, analog six-pack + HUD, live PAPI, 5 missions, graded landings |
| `serpent-shore-rally` | **Serpent Shore Rally** — Tidebreaker Coast Kart Racing | Pseudo-3D beach racing, 5 rivals, drift boosts, item boxes, ramps, shortcut, mobile controls |
| `cow-abductor` | **Cow Abductors** — 3D UFO Farm Heist | 3D Three.js, tractor beam, combos, minimap, power-ups, mobile joystick |
| `joust` | **Joust** — Skybound Rivalry | Deterministic flight combat, tiered rivals, hazards, eggs, endless waves, keyboard/gamepad/touch input |
| `void-blaster` | **Void Blaster** — Space Invaders | Waves, bunkers, mystery ship, combo×4, power-ups, mobile controls |
| `asteroid-drift` | **Asteroid Drift** — Vector Space | Splitting rocks, UFOs, hyperspace, shield bar, particles, mobile joystick |
| `neon-snake` | **Neon Snake** — Circuit Surge | Smooth motion, buffered turns, Focus slow-time, rescue shields, 5 food types, timed combos, touch controls |

## Layout

```
arcade-games/
├── index.html              # Hub — renders game cards from registry.json
├── registry.json           # Catalog source of truth
├── thumbnails/             # Game thumbnail images (PNG)
├── <game-id>/
│   ├── index.html          # Self-contained single-file game, or a shell that
│   └── src/*.js            #   loads ES modules (opus5-flight-sim does this)
└── scripts/
    └── validate-registry.ts
```

## Add a game

1. Create `<game-id>/index.html` — either a self-contained game or a production bundle whose assets use relative paths.
2. Add an entry to `registry.json`:
   ```json
   {
     "id": "your-game-id",
     "title": "Your Game",
     "subtitle": "tagline",
     "description": "one or two sentences",
     "path": "./your-game-id/index.html",
     "icon": "🕹️",
     "accent": "#22d3ee",
     "tags": ["2d", "puzzle"],
     "controls": ["Arrows — move", "Space — jump"],
     "status": "live",
     "featured": false,
     "added": "2026-07-03"
   }
   ```
3. Validate: `bun scripts/validate-registry.ts` (exit 0 = every entry resolves to an `index.html`).

The hub picks up the new card automatically — no edits to `index.html` required.

## Feature standard

All games follow the cow-abductor feature bar:
- Full HUD (score, lives, level, high score via `localStorage`)
- Difficulty selection (Easy / Normal / Hard)
- Pause screen (`P`), Game Over screen with session stats
- Power-ups, combo/multiplier system
- Web Audio API synth sounds (no external files), mute toggle
- CRT scanline aesthetic, Press Start 2P font
- Mobile touch controls (joystick or D-pad)
- `← BACK` link to hub

## Ticket

**ZOU-449** — Create a page for arcade games.
