# Bot HQ — build contract (v2: read the v2 overrides at the end first)

Live 3D "office" dashboard for Grok Bot bots. Each bot appends one JSON line per step to a shared
journal; a zero-dependency server tails it and the browser renders an isometric 3D office where every
bot is a glossy "jelly blob" character at a desk. No AI at runtime.

This file is the single source of truth between parallel builders. Do not change it; if something here
is impossible, say so in your report and pick the closest option.

## Folder ownership (write ONLY inside your folder)

| Path | Owner |
|---|---|
| `docs/`, `web/index.html`, `web/app.js`, `web/styles.css`, `web/scene/`, `web/data/` | integrator (lead) |
| `assets/blobs/`, `assets/_src/blobs/` | blob builder (Blender) |
| `assets/office/`, `assets/_src/office/` | office builder (Blender) |
| `web/ui/` | UI builder |
| `server/`, `start.sh`, `stop.sh`, `README-server.md` | server builder |
| `data/` | runtime only (journal, password, config) — never commit |

Tools available: Node 24, Python 3.13, Blender 5.2.2 at
`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` (run headless:
`blender -b --factory-startup -P script.py`), ffmpeg, RTX 3060 (Cycles GPU OK). Target runtime box is
Linux (Node 24, Python 3.13, no systemd/cron). Code and comments in English, UI text in Russian.

## 1. Journal (input) — `events.jsonl`, append-only, one JSON object per line

Activity line (written by every bot):
```json
{"t":"2026-10-31T16:43:05+02:00","bot":"X Writer","group":"X-контент","status":"working","step":"пишу драфт поста про Topaz","task":"tsk-1643"}
```
- `status`: `working` | `idle` | `waiting_user` | `error` | `done`. `group`, `task` optional. `step` ≤ 80 chars.

Usage line (one routine, every 1–2 h; any field may be null/missing):
```json
{"t":"...","type":"usage","period":"week","resets_at":"2026-11-03T00:00:00+02:00","total_used_pct":37,"bots":{"X Writer":4.1},"routines":{"R1":5.3}}
```
Schedule line (optional): `{"t":"...","type":"schedule","bot":"Grok Bot","routine":"R1","cron":"30 * * * *","last_run":"..."}`

Parser must survive garbage: non-JSON lines, unknown statuses, missing fields, lines > 4 KB, partial last
line, file truncation/rotation.

## 2. Bot identity

- `id` = slug of `bot` name: lowercase, Latin+Cyrillic transliterated to Latin, non-alnum → `-`, trimmed.
  Fixed ids for the demo bots (use exactly these):

| Name | id | Floor (group) |
|---|---|---|
| Grok Bot | `grok-bot` | Координация |
| Jevopus | `jevopus` | Координация |
| X Writer | `x-writer` | X-контент |
| Banner & Visuals | `banner-visuals` | X-контент |
| Analytics Analyst | `analytics-analyst` | X-контент |
| Competitor Watch | `competitor-watch` | X-контент |
| QT Scout | `qt-scout` | X-контент |
| Ideas Sparring | `ideas-sparring` | X-контент |
| Bookmarks Brain | `bookmarks-brain` | X-контент |
| Codila X Researcher | `codila-x-researcher` | X-контент |
| Тренды X: закладки и мега-охват | `trendy-x` | X-контент |
| Substack | `substack` | Публикации |
| X Ads Manager | `x-ads-manager` | Публикации |
| Warren Buffett | `warren-buffett` | Финансы |
| Finance Team | `finance-team` | Финансы |

- Avatar lookup: `assets/blobs/<id>.glb`; unknown bots use `assets/blobs/_default.glb` tinted at runtime
  with a color hashed from the id. 2D icon: `assets/blobs/thumbs/<id>.png` (fallback `_default.png`).
- Optional overrides file `data/bots.json`: `{"X Writer":{"floor":"x-content","chat_url":"grokbot://app/v1/agent?id=...","avatar":"x-writer"}}`.

## 3. Floors

- Floor = theme. Max **20 bots per floor** (5×4 desks). Floor of a bot: `data/floors.json` mapping if
  present, else its `group`, else `Общий этаж` (id `general`).
- Overflow: 21st bot of a group goes to floor `<id>-2` named `<name> · 2`.
- Floor ids for demo: `coordination` Координация, `x-content` X-контент, `publishing` Публикации,
  `finance` Финансы. Order = as listed.

## 4. State API (server → browser)

`GET /api/state` → full state. `GET /api/state?since=<version>` → `{"version":N,"unchanged":true}` when
nothing changed. Browser polls every 1000 ms (no SSE in v1: Cloudflare quick tunnels don't support it).

```json
{
  "version": 412,
  "now": "2026-10-31T19:00:00+02:00",
  "demo": true,
  "summary": {"working": 6, "idle": 5, "waiting_user": 2, "error": 1, "stuck": 1, "done": 0, "total": 15},
  "usage": {"period": "week", "total_used_pct": 37, "resets_at": "2026-11-03T00:00:00+02:00", "updated_at": "2026-10-31T18:00:00+02:00"},
  "floors": [
    {"id": "x-content", "name": "X-контент", "order": 2, "bots": ["x-writer", "qt-scout"],
     "counts": {"working": 4, "idle": 3, "waiting_user": 1, "error": 0, "stuck": 1, "done": 0}, "free_desks": 11}
  ],
  "bots": {
    "x-writer": {
      "id": "x-writer", "name": "X Writer", "floor": "x-content", "desk": 1, "group": "X-контент",
      "status": "working", "effective_status": "working",
      "step": "пишу драфт поста про Topaz", "task": "tsk-1643",
      "since": "2026-10-31T18:51:00+02:00", "last_event": "2026-10-31T18:58:40+02:00",
      "usage_pct": 4.1, "usage_share": 0.11, "chat_url": null, "avatar": "x-writer", "color": "#2F6BFF",
      "today": {"working_min": 42, "events": 17, "tasks_done": 3},
      "history": [{"t": "2026-10-31T18:58:40+02:00", "status": "working", "step": "..."}]
    }
  },
  "feed": [{"t": "2026-10-31T18:58:40+02:00", "bot": "x-writer", "name": "X Writer", "status": "working", "step": "..."}]
}
```
- `effective_status` adds derived states: `stuck` (working, no event > 30 min), `done` shown for 60 s then
  `idle`, anything silent > 3 h → `idle`.
- `desk`: 1..20, stable per bot within its floor (assignment order = first seen).
- `usage_share`: bot's share of `total_used_pct` (0..1) — drives the fuel bar. `history` = last 20 events,
  newest first. `feed` = last 100 events across all bots, newest first.
- Example file for UI development: `web/data/demo-state.json`.

## 5. Visual language

Monitor-first (1440×900 and up). Cozy, warm, daylight office (night mode later). UI chrome black & white,
color comes from the blobs.

Tokens:
```
--bg:#F6F1EA  --paper:#FFFFFF  --ink:#141414  --muted:#6E6A64  --line:#E7E0D6  --shade:#EFE8DE
--working:#22C55E --idle:#A8A29E --waiting:#F5B000 --error:#EF4444 --stuck:#F97316 --done:#3B82F6
font UI: "Manrope" 400/600/800 (Google Fonts); mono for feed: "JetBrains Mono" 400/500
radius: 14px panels, 999px pills; shadow: 0 1px 2px rgba(20,20,20,.06), 0 8px 24px rgba(20,20,20,.06)
```
Status labels (RU): working «работает», idle «отдыхает», waiting_user «ждёт тебя», error «ошибка»,
stuck «завис?», done «готово».

## 6. Page layout & module API

```
┌ #topbar (64px): Bot HQ · counters pills · week usage bar + reset countdown · DEMO badge ┐
├ #floors (left rail 220px) ┬ #scene (3D canvas, fills) ┬ #panel (right 380px) ┤
│ elevator: floor buttons   │ zoom + / − / reset         │ team grid → bot card │
│ with per-status counts    │ bottom-right of #scene      │ → activity feed      │
└───────────────────────────┴────────────────────────────┴──────────────────────┘
```
`web/index.html` (integrator) contains `<header id="topbar">`, `<nav id="floors">`, `<main id="scene">`,
`<aside id="panel">` and loads `web/app.js` as an ES module.

UI module `web/ui/ui.js` (ES module, no deps) + `web/ui/ui.css`:
```js
export function initUI({ onSelectBot, onSelectFloor, onZoom, onOpenChat }) // onZoom('in'|'out'|'reset')
export function renderUI(state, { currentFloor, selectedBot })              // idempotent, called every poll
```
Scene module `web/scene/scene.js` (integrator):
```js
export function initScene(container, { onSelectBot, onHoverBot })
export function renderScene(state, { currentFloor, selectedBot })
export function zoom(dir) ; export function focusBot(id)
```
`web/app.js` polls `/api/state`, keeps `currentFloor`/`selectedBot`, calls both render functions.

## 7. 3D scene contract (meters, glTF Y-up, +Z toward camera side)

Camera: orthographic, isometric — looks at room center from direction (1, 1, 1) (azimuth 45°,
elevation 35.26°). Only floor, back wall (z = −6) and left wall (x = −8) exist (cutaway diorama), wall
height 3 m, floor slab 0.25 m thick with visible edge.

Room interior: x ∈ [−8, 8], z ∈ [−6, 6]. Work zone: 5 columns × 4 rows of workstations, x ∈ [−7, 3],
z ∈ [−4.5, 4]. Lounge zone on the right: x ∈ [4, 7.8] (sofa, armchairs, coffee table, rug, plants,
bookshelf, coffee machine, floor lamp). Windows on both walls, a whiteboard on the back wall.

Workstation: chair at the station origin, desk directly in front of it (+Z side), laptop (not a tall
monitor) on the desk with its screen facing the chair (−Z), small desk plant/mug on some desks.
The blob sits on the chair and faces +Z.

**Required empties (exported as glTF nodes) in `assets/office/office.glb`:**
- `desk_01` … `desk_20` — at the seat surface where a blob's bottom rests, rotated so local +Z is the
  direction the blob faces. Row-major: row 1 = back row (most negative z), columns left→right.
- `screen_01` … `screen_20` — center of each laptop screen.
- `lounge_01` … `lounge_06` — seat surfaces in the lounge (sofa/armchairs/beanbags), local +Z = facing.

Lighting: warm daylight, sun from the back-left windows (light travels toward +X +Z), soft sky fill.
Floor and walls carry a baked lightmap (soft furniture shadows + AO) exported unlit
(`KHR_materials_unlit`) so the browser does not light them twice; furniture keeps PBR materials and is
lit in the browser by a hemisphere light + directional light from (−4, 8, −3) toward the origin.

**Blob GLB contract (`assets/blobs/<id>.glb`):** root node `blob`, children `body`, `eye_L`, `eye_R`
(+ optional `extra` for accessories). Origin at bottom center, max dimension ≈ 0.8 m, face looks toward
glTF +Z (Blender −Y). Body: glossy jelly PBR (roughness ≈ 0.3, clearcoat welcome). Eyes: white vertical
ovals, separate meshes (browser blinks them by scaling Y). ≤ 6k triangles each.
`_default.glb`: round blob, pure white body (tinted at runtime).

Integrator places blobs at `desk_NN` / `lounge_NN`, adds labels (HTML pills), status FX, hover/click.

## 8. Demo bots — appearance (reference screenshot of the real app avatars)

Glossy flat-color shapes with two white vertical-oval eyes, slightly tilted shapes:
Grok Bot — orange round fruit with a small dark stem; Codila X Researcher — black 8-point soft star;
X Ads Manager — caramel-brown rounded hexagon; Competitor Watch — caramel-brown rounded triangle,
tilted; Substack — orange rounded triangle, upright; QT Scout — orange-yellow horizontal pill;
Analytics Analyst — pink 4-lobe flower; Bookmarks Brain — teal rounded shield/squircle; Ideas
Sparring — red 4-point soft star; Тренды X — cluster of three mini blobs (black star, orange round,
teal round); Banner & Visuals — green rounded triangle/leaf; X Writer — blue rounded square tilted ~15°;
Jevopus — pink round blob; Warren Buffett — (placeholder) warm beige round blob with round black
glasses; Finance Team — (placeholder) money-green rounded square.

---

# v2 overrides (2026-10-31) — Apple-style building diorama

Approved look: `mockups/diorama/Bot-HQ-maket.png` (rendered by `assets/_src/mockup/diorama_mock.py`,
UI overlay `mockups/diorama/mock.html`). Where v2 and v1 disagree, v2 wins. Product rule: Bot HQ is
public — everything must work for ANY user's bots automatically (bots come from a screenshot → auto
blobs). No per-bot hand-made props or content. All text in Russian.

## v2 ownership (write ONLY inside your area)

| Area | Owner |
|---|---|
| `assets/office/`, `assets/_src/office/` | building builder (Blender) |
| `web/scene/` (scene.js, actor.js, office.js, any new files incl. `web/scene/scene.css`) | scene builder |
| `web/ui/`, `web/index.html`, `web/styles.css` | UI builder |
| `docs/`, `web/app.js`, `web/data/`, `server/`, `mockups/` | integrator (lead) |

## v2.1 Journal / state additions
- Journal `task` = short human task title ≤ 60 chars (e.g. "Тред про AI-агентов на понедельник"), not an id.
  Old id-like values (`tsk-1234`) may still appear: treat as "no title" and fall back to `step`.
- State: `bots[id].today.hourly` = array of 24 ints, events per local hour today (Europe/Sofia).
  Missing on old servers → treat as zeros.

## v2.2 Time of day (viewer's local clock)
Scene owns it and publishes it to the page:
- Phases: night 21:30–05:30 · dawn 05:30–07:30 (night→day) · day 07:30–17:30 · golden 17:30–19:30 (warm low
  sun) · dusk 19:30–21:30 (golden→night). Transitions are smooth (interpolate, never jump).
- Scene sets on `<html>`: `data-daylight="day|golden|dusk|night|dawn"` and CSS var `--night` (0 = full day,
  1 = full night, float), updated at most once per second.
- Overrides for testing: URL `?time=22:15` (fixed clock) or `?time=auto`; `window.bothq.setTime('22:15'|null)`.
- Night: interior lamps on, laptop screens glow, lower floors' windows glow (some lit, some dark), wall
  screen glows, background turns deep navy. UI switches to dark glass.

## v2.3 Layout (full-bleed scene, glass overlays)
`#scene` fills the whole viewport. UI floats on top as translucent glass panels (backdrop-filter blur),
exactly like `mockups/diorama/mock.html`: brand + live pill (top-left), status summary pill (top-center),
week usage pill (top-right), floors "elevator" panel (left), bot card / floor team card (right), live
feed (bottom-left), zoom −/+ (bottom-right). Font: Inter (Google Fonts). Status colors (Apple system):
working #34C759, waiting_user #FF9F0A, error #FF3B30, stuck #FF9500, done #0A84FF, idle #A1A1A6.
Ink #1D1D1F, muted #6E6E73. Night = dark glass (rgba(28,28,30,.62)) with light text.
Module APIs from §6 are unchanged (`initUI`, `renderUI`, `initScene`, `renderScene`, `zoom`, `focusBot`).
`web/index.html` must also load `./scene/scene.css` (scene-owned styles for in-scene tags and the canvas).
The scene needs the visible centre: keep the left panel ≤ 230 px and the right card ≤ 360 px wide.

## v2.4 Building GLB — `assets/office/office.glb` (replaces v1; keep v1 as `office-v1.glb`)
Meters, glTF Y-up, +Z toward the camera side, camera iso from (1,1,1). Footprint of every floor: slab
16.4 × 12.4 centred at origin, interior x ∈ [−8, 8], z ∈ [−6, 6]. Constants: `SLAB = 0.36`,
`FLOOR_STEP = 1.6` (closed floor module height incl. slab), open floor wall height 2.7.
Root nodes (the scene clones/positions them; each floor's origin = its walking surface, y = 0):
1. **`floor_open`** — the active floor, interior visible (cutaway: back wall z = −6 glass curtain wall with
   slim black mullions, left wall x = −8 solid white). Slab y ∈ [−0.36, 0], visible white edge.
   Contents (look = mockup): two long oak communal tables with slim black legs, 20 seats (low round
   fabric poufs), slim aluminium laptops, a few mugs; lounge on the right (block sofa, 2 armchairs, round
   oak coffee table, round rug); coffee bar along the glass; 2–3 small trees in white pots; 4–6 black
   pendant lamps over the tables. Children with fixed names:
   - empties `desk_01`…`desk_20` (pouf top where a blob's bottom rests, local +Z = facing direction;
     01–10 = table 1, 11–20 = table 2; on each table odd numbers = far side facing +Z),
     `screen_01`…`screen_20` (centre of that seat's laptop screen), `lounge_01`…`lounge_06` (sofa ×3,
     armchairs ×2, bar stool ×1), `lamp_01`…`lamp_06` (bulb positions for night point lights).
   - mesh `laptop_screen_NN` (NN = desk) — the screen face, material named `night_screen`.
   - mesh `wall_screen` — flat quad on the left wall (≈ 2.6 × 1.46 m, 16:9), UV 0..1 upright, facing +X.
     Scene draws live stats on it via CanvasTexture.
   - mesh `task_board` — flat quad on the left wall (≈ 3.0 × 1.5 m, 2:1), UV 0..1 upright, facing +X,
     not overlapping `wall_screen`. Scene draws live task cards on it.
   - materials named `night_lamp` (lamp shades/bulbs, emissive at night).
   - baked surfaces (floor, walls, slab top): meshes named `baked_*`, unlit, day lightmap embedded;
     the night lightmap for each lives next to the GLB as `assets/office/night/<mesh name>.jpg`
     (same UVs, lamps on, sun off, sky dark navy). Scene crossfades day→night by `--night`.
2. **`floor_closed`** — a closed floor seen from outside: slab y ∈ [−0.36, 0] + dark tinted glass band
   y ∈ [0, 1.24] with thin light mullions on all 4 faces. Glass material `night_windows` with an
   emissive map (warm window pattern, ~40 % of panes lit) that the scene ramps up at night.
3. **`roof`** — roof slab with parapet + a few rooftop boxes (AC units), origin at its bottom.
4. **`elevator_shaft`** — glass shaft segment exactly 1 m tall (scene scales Y), on the +X face of the
   building: footprint centre (9.05, z = −2.6), 1.5 × 1.5 m, thin black corner posts, glass alpha.
5. **`elevator_cabin`** — glass cabin with black frame and light floor, ≈ 1.3 × 2.2 × 1.3, origin at its
   floor, positioned in plan at the shaft centre.
Floor `k` (1 = lowest by `floors[].order`) has its walking surface at `y = (k − 1) × FLOOR_STEP`.
Floors above the active one are lifted out of view ("roof lifts"), floors below are `floor_closed`.
Budget: GLB ≤ 6 MB, night JPGs ≤ 2 MB total, ≤ 150k triangles.

## v2.5 Scene behaviour (owner: scene builder)
- Floor switch = elevator: cabin rides to the target floor, camera target follows it on a critically damped
  spring (Apple: damping 1.0, response ≈ 0.5 s), floors above lift up + fade out, the new open floor
  slides in. Total ≈ 1–1.4 s, interruptible (switch again mid-flight → re-target from current values).
- Mouse: bots within ~3.5 m of the cursor (ground point) turn toward it (seated working bots: limited turn,
  never leave the desk), eyes shift toward it; cursor within ~0.9 m → a hop (cooldown ~1.2 s). Hover/click
  as in v1. Springs, not tweens.
- Tilt-shift "miniature" post effect: sharp band around the active floor, soft blur toward the top and
  bottom edges. Subtle. `?tiltshift=0` disables.
- In-scene tags: quiet by default — only the selected bot (dark pill with name), bots needing the user
  (`waiting_user`, `error`, `stuck`: compact white pill with a short reason) and the hovered bot.
- Wall screen: "Сегодня · <floor name>": working now X из Y, events today, tasks done today, hours worked
  today, and a 24-bar hourly chart (sum of `today.hourly` over the floor's bots, current hour highlighted).
- Task board: one card per bot on the floor (attention first, then working, then the rest; max 8 + "+N"):
  bot colour stripe, bot name, task title (fallback: step), status dot.
- Everything degrades gracefully: missing GLB → procedural placeholder that follows this same contract.

## v2.6 Generated avatars (blobs from a screenshot)
Product rule from v2 made concrete: any user's bots get a blob without Blender.
- **Input:** the user sends their Grok Bot a screenshot of the bot list; Grok Bot (vision) writes one entry per bot
  into `data/bots.json`: `"<bot name>": {"look": {"shape": "...", "color": "#RRGGBB", "accessory": "..."}}`.
  Exact prompt and format: `docs/AVATARS.md`.
- **Vocabularies (closed):** shape = `sphere, rounded_cube, pill, triangle, cone, pentagon, hexagon, star4, star6, clover,
  rounded_square, trio`; accessory = `none, glasses, stem, antenna, bow`. Single source of truth in the browser:
  `web/scene/looks.js`; the server keeps a copy in `server/state.js` and a test compares the two.
- **State (§4 addition):** `bots[id].look` = `{shape, color, accessory}` or `null`. Validation is per field: unknown
  shape -> `null`, colour must be `#RRGGBB` (else `null`), unknown accessory -> `"none"`; a look with neither a usable
  shape nor a usable colour is `null`. Without an explicit `color`, `look.color` also becomes `bots[id].color`.
  `bots[id].has_glb` (bool, optional) = `assets/blobs/<avatar>.glb` exists on the server; absent on older servers.
- **Avatar chain in `scene.js attachModel`:** (1) hand-made `assets/blobs/<avatar>.glb` (skipped when `has_glb` is
  `false`), else (2) `generateBlob(bot.look)`, else (3) `generateBlob` with shape and colour derived from the bot id
  (`bot.color` is the hashed colour from the server). A look that changes later (bots.json is hot-reloaded) re-dresses
  the bot on the next poll. `assets/blobs/_default.glb` is no longer used by the scene.
- **`web/scene/blobgen.js`:** `generateBlob({ shape, color, accessory, seed })` returns the §7 structure (root `blob`;
  `body`, `eye_L`, `eye_R`, optional `extra`), same recipe as `assets/_src/blobs/build_blobs.py` (inflated slab from a
  polar outline, round bevel, white vertical-oval eyes, jelly PBR: roughness 0.3, clearcoat 1). Deterministic per
  (shape, colour, accessory, seed); the seed only picks a small tilt (-8..+8 deg). Geometry is cached per
  shape + tilt + accessory, materials per colour. <= 6000 triangles per blob. `trio` has three bodies (one mesh, three
  materials: the colour, a companion hue, a dark tone) and three eye pairs: the front pair is `eye_L`/`eye_R`, the others
  `eye_L_2`, `eye_R_2`, `eye_L_3`, `eye_R_3` (actor.js matches `/^eye_[LR]/`, so they blink and glance together).
  The `extra` mesh reports a bounding box that overhangs the body by at most 5 cm, so an antenna does not make its
  blob smaller than its neighbours when actor.js fits the model to 1 m.
- **Review page:** `web/scene/blobgen.html` (served at `/scene/blobgen.html`): every shape x colour, accessories, the
  hash fallback, the 15 demo bots (hand-made GLB next to the generated one, looks in `web/data/demo-looks.json`),
  an office-scale strip and a self-test (triangle budget, GLB structure, determinism).

## v2.7 Bots-only mode: one feed address, the status rule, silence made visible (2026-11-02)
- **One address.** The bots post to and the office reads `FEED_BASE + topic`. `FEED_BASE` lives in
  `web/lib/feedbase.js` (default `https://ntfy.sh/`); the setup prompt (`PROMPT.md`, step 1) builds the same address, and
  the wallpaper (`web/face/face.js`) and the landing keep a copy. `server/test/feedbase.test.js` fails when they differ, so
  a new base is changed in all of them at once (a non-default base also goes into the prompt's LINK as `#<topic>@<host>`).
  Another mailbox is named by the link: `#<topic>@<host or https URL>`, `?feed=<host or https URL>`, or the older
  `#<topic>&ntfy=<https URL>`. A bare `?feed=<topic>` is still an old wallpaper link (topic, default base). The office
  reads that one mailbox only (no merging); a self-hosted relay is `#<topic>@relay.example.com`.
- **Channel lines** (one JSON object per message, ≤ 4 KB): status `{"bot","status","step"}`, `{"roster":[…]}`,
  `{"looks":{…}}`, `{"groups":{…}}`, `{"chat":{…}}`, `{"routines":{"bot","items":[…]}}`,
  `{"type":"usage","total_used_pct","resets_at","bots":{…}}`, and new: `{"check":{"bots":["Bot A",…]}}` (the setup bot
  starts a status check).
- **The status rule lives in each bot's own instructions**, not only in shared memory (bots skip shared memory while
  busy). The setup bot prepends it as line 1 of every description (UpdateAgent for teammates, UpdateProfile for itself),
  with the real name and FEED written in:
  `STATUS RULE, FIRST and LAST action of every turn in which you get a message (from me or from another bot): run curl -s -d '{"bot":"<exact name>","status":"working","step":"<task, max 80 chars>"}' <FEED_BASE><TOPIC> before anything else, and the same with done, idle, waiting_user or error right before your final reply. Never skip it, and never post the same line twice in a row. Valid JSON only, no secrets in step.`
  A daily 08:00 routine of the setup bot re-adds the line to any bot whose description lacks it (new, renamed or edited
  bots) and posts one test line per fixed bot. Setup ends with a status check: the `check` line, then SendToAgent
  "status check" to each teammate; the setup reply names the bots that did not post. Bots set up with the earlier prompt
  get the same through `UPGRADE.md` (one message; it keeps their FEED and link), shown folded on the landing; a test keeps
  its STATUS RULE line identical to `PROMPT.md`'s.
- **Rate:** no duplicate consecutive statuses (the rule says so). The free ntfy.sh takes about 250 messages a day; the
  prompt and the landing say so.
- **Office fallbacks** (`web/lib/state.js` with `quietIdleMs`, set by `web/feed.js` to 20 min):
  - a `working` bot with no new line for 20 min is `idle` (`effective_status`), not `stuck`; its work time stops there.
    The local server keeps the v1 rule (`stuck` after 30 min).
  - `bots[id].last_seen` = ISO time of the bot's own last status line (`null` if it never posted; a roster line does not
    count). The floor team list shows it on every row ("12m"), the bot card as "seen 12 min ago".
  - `bots[id].unreported` = `{ from, to }` (ISO) when the bot's usage rose by ≥ 0.5 points between two usage lines and it
    posted no status line in that window; `null` once it posts again or after 24 h. Shown instead of "resting":
    "Worked (unreported) · 09:00–13:00".
  - `state.check` = `{ t, bots: [{ id, name, at }] }` for the latest check line of the last 6 h (`at` = the bot's own status
    line at or after `t`, else `null`). The dock shows a «Status check» card while it exists: a tick and time per bot,
    "waiting…", then "no answer" after 15 min.
