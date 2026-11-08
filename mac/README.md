# Grok Bot Wallpaper for Mac

A live wallpaper: the big Grok Bot rises from the bottom of the screen, its eyes follow your cursor, and cards
show your bots. On Windows this runs in Lively; on the Mac it is this small app. Needs macOS 13 Ventura or newer,
on Apple silicon (M1–M4) or Intel.

## Install

1. Download `GrokBotWallpaper.dmg`:
   - from the releases page: <https://github.com/Bodila51/grokbot-wallpaper/releases/latest>;
   - or the newest build: **Actions** tab → "Mac app" → latest green run → **Artifacts** →
     `GrokBotWallpaper-dmg` (a zip with the `.dmg` inside; needs a GitHub login).
2. Open the `.dmg` and drag **Grok Bot Wallpaper** into **Applications**.
3. First launch. The app is not signed with a paid Apple developer account, so macOS asks you to confirm it once:
   - **macOS 13–14:** in Applications, right-click the app → **Open** → **Open** again in the dialog.
   - **macOS 15 and newer:** double-click the app → "could not verify…" → **Done**. Then open
     **System Settings → Privacy & Security**, scroll down to the line about Grok Bot Wallpaper, click
     **Open Anyway**, enter your password → **Open**.
   - If that does not work, one Terminal command does the same:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Grok Bot Wallpaper.app"
     ```

After that it opens like any app. It has no Dock icon, only the 👀 icon in the menu bar.

## Menu (the 👀 icon in the menu bar)

- **Move cards** makes the wallpaper clickable for a while (above the desktop icons) so you can drag the cards.
  Turn it off with the same item, the **Esc** key, or by clicking any other app. The icon shows ✋ meanwhile.
- **Bot: White / Black** picks the bot's colour. The choice is remembered and re-applied after every reload.
  Until you pick one, the page decides (white, or `?bot=black` in the wallpaper address).
- **Reload wallpaper** reloads the page, e.g. after a design update.
- **Bots channel…** connects your bots: paste your channel (`gbw-…`) or any dashboard or wallpaper link
  with it. The wallpaper then shows `…/face/#<channel>` and remembers it; an empty value removes the bots.
- **Wallpaper address…** sets the page to show. Default: `https://bodila51.github.io/grokbot-wallpaper/face/`.
  A topic link like `https://bodila51.github.io/grokbot-wallpaper/face/#your-topic` works (`https://` may be left
  out), and so does your own bot server: `http://localhost:8787/face/?key=…`
  (see [README-server.md](../README-server.md)). **Default** goes back to the demo.
- **Match menu bar to wallpaper** (on by default) makes the system desktop picture a snapshot of the wallpaper,
  refreshed every 10 minutes and after reloads, so the menu bar and Mission Control take its colours. Your own
  picture comes back when you turn this off or choose Quit. A moving (Aerial) wallpaper cannot be put back this
  way: pick it again in System Settings. The snapshots live in `~/Library/Application Support/Grok Bot Wallpaper/`.
- **Launch at login** starts the wallpaper when you log in. If macOS wants approval,
  System Settings → General → Login Items opens.
- **Quit**.

## Permissions

None. The app needs no Accessibility, Input Monitoring or Screen Recording access:

- the cursor position is read with `NSEvent.mouseLocation`, a plain position read that needs no permission
  (macOS permissions guard keystrokes and event taps, not where the cursor is);
- the wallpaper window lets every click through, so the desktop icons work as usual;
- the cursor reaches the page up to 60 times a second, only when it moved, as the same `pointermove` event
  a browser would send.

If macOS asks for something anyway, please report what exactly: the rules changed in a new macOS version.
The only expected prompt is "Local Network", and only when the wallpaper address points to another computer
on your network (never for `localhost`).

## Battery

While the screens sleep, another user is active, or every wallpaper is covered by windows or a full-screen app,
the cursor is not sent to the page. macOS also slows the hidden page down by itself.

If the eyes stop following although the wallpaper is visible (macOS wrongly reports the window as covered),
turn this pause off and restart the app:

```bash
defaults write io.github.bodila51.grokbot-wallpaper pauseWhenCovered -bool false
```

## Uninstall

Turn off Launch at login, choose Quit, delete the app from Applications. Settings:

```bash
defaults delete io.github.bodila51.grokbot-wallpaper
```

## Development

- Sources: `Sources/GrokBotWallpaper/` (Swift, AppKit + WKWebView), no Xcode project, just `Package.swift`.
- App icon: `Resources/AppIcon.png` (a copy of `assets/brand/logo-mark.png`), turned into `.icns` by the build.
- Build on a Mac: `bash mac/build.sh` → `mac/dist/GrokBotWallpaper.dmg` (the universal build needs full Xcode).
- GitHub builds the `.dmg` itself (`.github/workflows/mac.yml`) on every push that touches `mac/`.
- Release: `git tag mac-v1.0 && git push origin mac-v1.0` publishes a release with the `.dmg`.
- Debug the page inside the wallpaper: Safari → Develop → your Mac → Grok Bot Wallpaper.

## Test on a real Mac

- [ ] The eyes follow the cursor everywhere: over the desktop, over other apps' windows, in the menu bar.
- [ ] Desktop icons can be clicked, selected with a marquee and dragged; right-click on the desktop works.
- [ ] Move cards: the cards drag; Esc / the menu item / clicking another window turns the mode off.
- [ ] Two displays: wallpaper on both, the eyes on one look towards the cursor on the other; unplugging and
      plugging a display back does not break it.
- [ ] Spaces: the wallpaper is on every desktop and stays when switching; it never shows in Mission Control.
- [ ] Bot: White / Black changes the colour on all displays at once and survives Reload wallpaper and a restart.
- [ ] Bots channel… takes `gbw-…` or a dashboard link and shows the bot cards; an empty value removes them,
      also after Reload wallpaper.
- [ ] Wallpaper address accepts `…/face/#your-topic` and shows that topic.
- [ ] Match menu bar to wallpaper: the menu bar takes the sky's colours (not your old picture's); turning it off
      or Quit brings your own desktop picture back.
- [ ] Launch at login: after logging out and in, the wallpaper comes back by itself.
- [ ] A full-screen app on top, then screen sleep: afterwards the eyes follow again.
- [ ] The app icon (white ball with black eyes) shows in Finder and in the `.dmg`.
