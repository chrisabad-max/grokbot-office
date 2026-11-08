# Grok Bot wallpaper for Lively Wallpaper

A live wallpaper: the big white Grok Bot ball rises from the bottom of the screen, its eyes follow your cursor,
and cards on the right show what your bots are doing. Lively shows the **live page from your local server**
`http://127.0.0.1:8787/face/`: the wallpaper itself is only a tiny `index.html` that opens that page right away.
Edit files in the repo, reload the wallpaper, and the change is on screen.

You need Windows 10/11, [Node.js 24+](https://nodejs.org) and [Lively Wallpaper](https://github.com/lively-community/lively)
(GitHub installer or Microsoft Store). No admin rights needed.

## Install (one click)

1. Double-click **`lively\install.cmd`**. It:
   - puts a shortcut in the Startup folder, so the Bot HQ server starts hidden every time you sign in to Windows;
   - starts the server now;
   - builds `lively\dist\grokbot-wallpaper.zip` (the page link with your view key inside);
   - if Lively came from the GitHub installer, adds the wallpaper to the Lively library and turns it on for the main screen.
2. If Lively came from the Microsoft Store (or was not found), a folder with `grokbot-wallpaper.zip` opens:
   drag it into the Lively window (or **Add Wallpaper** and choose the file).

Rebuild only the zip: `powershell -ExecutionPolicy Bypass -File lively\build.ps1`

## Mouse: eyes and cards

In Lively: **Settings → Wallpaper → Input: Mouse**, and turn on **Mouse interaction when application focused**
so the eyes follow the cursor over open windows too. (A fresh Lively has both on already.)

- The eyes follow the cursor; with no mouse around, the ball looks around and blinks on its own.
- Drag the cards with the mouse right on the desktop.
- Desktop icons stay on top of the wallpaper and click as usual.
- **Hide the desktop icons** if the selection box gets in the way: right-click the desktop → View → uncheck
  "Show desktop icons". Lively only mirrors clicks to the wallpaper; the real click goes to the Windows desktop,
  so with icons on, dragging a card also draws the blue selection box.

## Settings: bot color and your bots

In the Lively library, right-click Grok Bot → **Customise Wallpaper**:
- **Bot color**: White or Black. Lively sends it to the page at once and keeps it after a reload.
- **Your bots channel**: your bots' ntfy.sh channel; the wallpaper then shows your bots instead of the demo.
  The channel name works like a password: do not post it.

## Several monitors

`install.cmd` puts the wallpaper on the main screen. For all screens: **Settings → Wallpaper → Wallpaper arrangement**:
**Duplicate** (the same wallpaper on every screen) or **Span** (one page across all screens).
Or, with **Per Display**, pick Grok Bot for each monitor. On a portrait monitor the ball sits at the bottom
and the cards at the top right.

## How edits show up

- `web\face\*` and `assets\face\*`: save the file and **reload the wallpaper**. The server sends them uncached
  (`--no-cache`), so the new version arrives right away.
- To reload: `lively\reload.cmd` (Lively from the GitHub installer), or in the Lively library right-click Grok Bot →
  **Set as Wallpaper**.
- Bot statuses update by themselves every 2 seconds, no reload needed.
- Edits in `server\`: restart the server with `lively\uninstall.cmd`, then `lively\install.cmd`.
- Your own bot journal instead of `data\events.jsonl`: set the user environment variable `BOTHQ_JOURNAL=<path>`,
  then restart the server. Another port: `BOTHQ_PORT` (then run `install.cmd` again so the link in the zip updates).

## Uninstall

Double-click **`lively\uninstall.cmd`**: it removes the Startup shortcut, stops the server the autostart started
(it leaves any other dev server on the same port alone), removes the wallpaper from the Lively library (if
`install.cmd` added it) and deletes `lively\dist`. If you added the zip by hand: in Lively, right-click Grok Bot →
**Delete**. The repo and `data\` stay.

## Security

`grokbot-wallpaper.zip` and the Lively library (`index.html`) hold a link with the view key from `data\view-key.txt`;
Lively also writes that link to its own log (`%LOCALAPPDATA%\Lively Wallpaper\logs`). The key opens the dashboard
for viewing. The zip is in `.gitignore`: do not post or share it.
New key: delete `data\view-key.txt` and restart the server (`uninstall.cmd`, `install.cmd`).

## Troubleshooting

- A password box instead of the ball: the key in the link is old. Run `install.cmd` again.
- A black screen or "can't reach this page": the server is not running. Open `http://127.0.0.1:8787/healthz`
  in a browser (it should say `ok`); log: `data\autostart.log`.

## Files

| File | What it does |
|---|---|
| `install.cmd` / `install.ps1` | server autostart + zip build + install into Lively |
| `uninstall.cmd` / `uninstall.ps1` | undoes all of it |
| `server.ps1` | starts the server hidden if the port does not answer yet (the Startup shortcut runs it) |
| `build.ps1` | builds `dist\grokbot-wallpaper.zip` with the key; the tile picture is `assets\brand\logo-mark.png` |
| `reload.cmd` | reloads the wallpapers in Lively |
| `LivelyInfo.json` | the wallpaper description for Lively (a web wallpaper: `index.html` opens the live page) |
| `LivelyProperties.json` | the **Customise Wallpaper** settings (`botColor`, `feed`); the page gets them through `livelyPropertyListener` |
| `build-public.ps1` | builds `dist\grokbot-wallpaper-windows.zip`, the package for everyone (below) |
| `public\` | that package's files: `index.html`, `LivelyInfo.json`, `LivelyProperties.json`, `thumbnail.jpg`, `preview.gif` |

## The public package (anyone, no server)

`lively\dist\grokbot-wallpaper-windows.zip` is what the site offers: the release `windows-v1.0` (a `windows-v*` tag publishes it, `.github/workflows/windows.yml`, so GitHub counts its downloads), and for older links at `download/grokbot-wallpaper-windows.zip`
(`landing\assemble.mjs`; the zip is committed, it has no key). Drag it into Lively. Its `index.html` waits until
GitHub Pages answers (at sign-in Lively often starts before the network), then opens
`https://bodila51.github.io/grokbot-wallpaper/face/` with the Lively settings in the link (`?bot=black`, `#<channel>`);
later changes in **Customise** go straight to `face.js`. With no channel the wallpaper shows only the bot and its sky.
The **Your bots channel** box takes the channel name (`<topic>` or `<topic>@<https host>`), not a whole link.
`thumbnail.jpg` and `preview.gif` are renders of the wallpaper at dusk; rebuild after editing `public\`:
`powershell -ExecutionPolicy Bypass -File lively\build-public.ps1`
