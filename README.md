# Zouroboros Arcade

A registry-driven HTML5 arcade hub. Add a game by dropping a directory and one entry in `registry.json` — no build step, no server-side runtime.

**Live:** https://zouroboros-arcade-marlandoj.zocomputer.io

## Games

| ID | Title | Features |
|----|-------|----------|
| `cow-abductor` | **Cow Abductors** — 3D UFO Farm Heist | 3D Three.js, tractor beam, combos, minimap, power-ups, mobile joystick |
| `void-blaster` | **Void Blaster** — Space Invaders | Waves, bunkers, mystery ship, combo×4, power-ups, mobile controls |
| `asteroid-drift` | **Asteroid Drift** — Vector Space | Splitting rocks, UFOs, hyperspace, shield bar, particles, mobile joystick |
| `neon-snake` | **Neon Snake** — Glow Trails | 5 food types, ghost mode, portal walls, speed ramp×5, swipe controls |

## Layout

```
arcade-games/
├── index.html              # Hub — renders game cards from registry.json
├── registry.json           # Catalog source of truth
├── thumbnails/             # Game thumbnail images (PNG)
├── <game-id>/
│   └── index.html          # Self-contained single-file game
└── scripts/
    └── validate-registry.ts
```

## Add a game

1. Create `<game-id>/index.html` — single self-contained file (inline CSS/JS).
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
