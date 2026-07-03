# Arcade

A self-contained arcade-games hub that hosts browser games. The catalog is **registry-driven** — add a game by dropping a directory and adding one entry to `registry.json`. No build step, no server-side runtime.

## Layout

```
games/
├── index.html              # The hub page (renders cards from registry.json)
├── registry.json           # Single source of truth for the game catalog
├── README.md               # This file
├── scripts/
│   └── validate-registry.ts  # Asserts every registry entry has a playable dir + index.html
└── <game-id>/
    └── index.html          # A single-file, self-contained game
```

## Play

Open `games/index.html` in a browser, or serve the folder:

```bash
cd games && python3 -m http.server 8080
# visit http://localhost:8080/
```

> Opening `index.html` via `file://` also works — the hub falls back to an embedded
> default catalog if the `registry.json` fetch is blocked.

## Add a game

1. Create `games/<your-game-id>/index.html` — a single self-contained file
   (inline CSS/JS, CDN deps via importmap are fine; see `cow-abductor/` for the pattern).
2. Add an entry to `games/registry.json`:
   ```json
   {
     "id": "your-game-id",
     "title": "Your Game",
     "subtitle": "tagline",
     "description": "one or two sentences",
     "path": "./your-game-id/",
     "icon": "🕹️",
     "accent": "#22d3ee",
     "tags": ["2d", "puzzle"],
     "controls": ["Arrows — move", "Space — jump"],
     "status": "live",
     "featured": false,
     "added": "2026-07-03"
   }
   ```
3. Validate:
   ```bash
   bun games/scripts/validate-registry.ts
   ```
   Exit `0` = every registry entry resolves to a directory containing `index.html`.

That's it — the hub picks up the new card automatically. No edits to `index.html` required.

## Games

| ID | Title | Status |
|----|-------|--------|
| `cow-abductor` | Cow Abductors — 3D UFO Farm Heist | live |

## Notes

- `games/cow-abductor/index.html` is a byte-faithful port of
  `Projects/cow-abductors/index.html` (Three.js + Web Audio, single file). The only
  addition is a non-invasive "← Arcade" back-link overlay spliced before `</body>`.
- Ticket: **ZOU-449** (Dark Factory intake). Branch: `factory/zou-449-create-a-page-for-arcade-games`.
