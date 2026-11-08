import AppKit
import ServiceManagement

/// Grok Bot Wallpaper for macOS, the Mac counterpart of the Lively setup on Windows: the wallpaper page live
/// on every display, the eyes following the cursor, and a menu-bar icon for the few settings.
@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)            // no Dock icon, only the menu-bar icon
        withExtendedLifetime(delegate) { app.run() }
    }

    private var wallpapers: [CGDirectDisplayID: Wallpaper] = [:]
    private var feed: CursorFeed!
    private var statusItem: NSStatusItem!
    private var dragItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var whiteBotItem: NSMenuItem!
    private var blackBotItem: NSMenuItem!
    private var matchItem: NSMenuItem!
    private var matcher: DesktopMatcher!
    private var dragMode = false
    private var dragSince = Date.distantPast
    private var escMonitor: Any?
    private var screensAsleep = false
    private var sessionAway = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        feed = CursorFeed()
        matcher = DesktopMatcher()
        installEditMenu()
        buildStatusItem()
        syncWallpapers()

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(screensSlept), name: NSWorkspace.screensDidSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(screensWoke), name: NSWorkspace.screensDidWakeNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionLeft), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionBack), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        workspace.addObserver(self, selector: #selector(spaceChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        let drift = Timer.scheduledTimer(timeInterval: 600, target: self, selector: #selector(skyDrifted), userInfo: nil, repeats: true)
        drift.tolerance = 60
        perform(#selector(checkInstallPlace), with: nil, afterDelay: 1)
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        matcher.restore(screenPairs())
    }

    // Clicking any other app ends drag mode, so the icons never stay hidden behind the page.
    func applicationDidResignActive(_ notification: Notification) {
        if dragMode, Date().timeIntervalSince(dragSince) > 1.5 { setDrag(false) }
    }

    // MARK: one wallpaper per display

    // Displays come and go in bursts (wake, rearranging): let them settle, then sync once.
    @objc private func screensChanged() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(syncWallpapers), object: nil)
        perform(#selector(syncWallpapers), with: nil, afterDelay: 0.5)
    }

    @objc private func syncWallpapers() {
        var present = Set<CGDirectDisplayID>()
        for screen in NSScreen.screens {
            guard let id = screen.displayID else { continue }
            present.insert(id)
            if let wallpaper = wallpapers[id] {
                wallpaper.setFrame(screen.frame)
            } else {
                let wallpaper = Wallpaper(frame: screen.frame, url: Settings.url)
                wallpaper.onLoad = { [weak self] in
                    self?.feed.resend()
                    self?.matchDesktopSoon(3)                  // let the sky and the ball paint first
                }
                NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged),
                                                       name: NSWindow.didChangeOcclusionStateNotification, object: wallpaper.window)
                wallpapers[id] = wallpaper
            }
        }
        for (id, wallpaper) in wallpapers where !present.contains(id) {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: wallpaper.window)
            wallpaper.close()
            wallpapers[id] = nil
        }
        for wallpaper in wallpapers.values { wallpaper.setInteractive(dragMode) }
        feed.targets = Array(wallpapers.values)
        updateFeed()
        matchDesktopSoon(3)
    }

    // MARK: the system desktop picture follows the wallpaper (the menu bar is tinted from it)

    private func matchDesktopSoon(_ delay: TimeInterval) {
        guard Settings.matchDesktop else { return }
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(matchDesktopNow), object: nil)
        perform(#selector(matchDesktopNow), with: nil, afterDelay: delay)
    }

    @objc private func matchDesktopNow() {
        guard Settings.matchDesktop, !screensAsleep, !sessionAway else { return }
        for (screen, id) in screenPairs() {
            if let wallpaper = wallpapers[id] { matcher.update(screen, id: id, from: wallpaper.webView) }
        }
    }

    @objc private func skyDrifted() { matchDesktopSoon(0) }

    @objc private func spaceChanged() {
        if Settings.matchDesktop { matcher.reapply(screenPairs()) }
    }

    @objc private func toggleMatch() {
        Settings.matchDesktop.toggle()
        if Settings.matchDesktop { matchDesktopSoon(0) } else { matcher.restore(screenPairs()) }
    }

    private func screenPairs() -> [(NSScreen, CGDirectDisplayID)] {
        NSScreen.screens.compactMap { screen in screen.displayID.map { (screen, $0) } }
    }

    // MARK: battery: the cursor feed runs only while a wallpaper can be seen

    @objc private func occlusionChanged() { updateFeed() }
    @objc private func screensSlept() { screensAsleep = true; updateFeed() }
    @objc private func screensWoke() { screensAsleep = false; updateFeed(); matchDesktopSoon(3) }
    @objc private func sessionLeft() { sessionAway = true; updateFeed() }
    @objc private func sessionBack() { sessionAway = false; updateFeed() }

    private func updateFeed() {
        // covered = a full-screen app or windows over every display
        let covered = Settings.pauseWhenCovered && !dragMode && !wallpapers.values.contains(where: { $0.isVisible })
        if screensAsleep || sessionAway || wallpapers.isEmpty || covered { feed.stop() } else { feed.start() }
    }

    // MARK: menu-bar icon

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        dragItem = menuItem("Move cards", #selector(toggleDrag))
        loginItem = menuItem("Launch at login", #selector(toggleLogin))
        whiteBotItem = menuItem("Bot: White", #selector(chooseBot(_:)))
        whiteBotItem.representedObject = "white"
        blackBotItem = menuItem("Bot: Black", #selector(chooseBot(_:)))
        blackBotItem.representedObject = "black"
        menu.addItem(dragItem)
        menu.addItem(.separator())
        menu.addItem(whiteBotItem)
        menu.addItem(blackBotItem)
        menu.addItem(.separator())
        menu.addItem(menuItem("Reload wallpaper", #selector(reloadWallpapers)))
        menu.addItem(menuItem("Bots channel…", #selector(editChannel)))
        menu.addItem(menuItem("Wallpaper address…", #selector(editAddress)))
        menu.addItem(.separator())
        matchItem = menuItem("Match menu bar to wallpaper", #selector(toggleMatch))
        menu.addItem(matchItem)
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit", #selector(quit), key: "q"))
        statusItem.menu = menu
        updateIcon()
    }

    private func menuItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        dragItem.state = dragMode ? .on : .off
        let bot = Settings.bot ?? "white"
        whiteBotItem.state = bot == "white" ? .on : .off
        blackBotItem.state = bot == "black" ? .on : .off
        matchItem.state = Settings.matchDesktop ? .on : .off
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let image = NSImage(systemSymbolName: dragMode ? "hand.draw" : "eyes", accessibilityDescription: "Grok Bot Wallpaper")
        image?.isTemplate = true
        button.image = image
        button.title = image == nil ? (dragMode ? "✋" : "👀") : ""
        button.toolTip = dragMode ? "Move cards: on (Esc to turn off)" : "Grok Bot Wallpaper"
    }

    // MARK: «Move cards»: the page takes real clicks for a while, above the desktop icons

    @objc private func toggleDrag() { setDrag(!dragMode) }

    private func setDrag(_ on: Bool) {
        guard on != dragMode else { return }
        dragMode = on
        for wallpaper in wallpapers.values { wallpaper.setInteractive(on) }
        if on {
            dragSince = Date()
            NSApp.activate(ignoringOtherApps: true)
            let mouse = NSEvent.mouseLocation
            let underMouse = wallpapers.values.first { NSMouseInRect(mouse, $0.window.frame, false) }
            (underMouse ?? wallpapers.values.first)?.window.makeKey()
            escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.keyCode == 53 else { return event }     // Esc
                self?.setDrag(false)
                return nil
            }
        } else {
            if let monitor = escMonitor { NSEvent.removeMonitor(monitor) }
            escMonitor = nil
            NSApp.deactivate()
        }
        updateIcon()
        updateFeed()
    }

    // MARK: the other menu items

    @objc private func chooseBot(_ sender: NSMenuItem) {
        guard let bot = sender.representedObject as? String else { return }
        Settings.bot = bot
        for wallpaper in wallpapers.values { wallpaper.applyBot() }
        matchDesktopSoon(1.5)                                  // once the other ball has loaded
    }

    @objc private func reloadWallpapers() {
        let url = Settings.url
        for wallpaper in wallpapers.values { wallpaper.refresh(url) }
    }

    // The Mac side of Lively's channel box: the channel goes into the wallpaper address as …/face/#<channel>.
    @objc private func editChannel() {
        let alert = NSAlert()
        alert.messageText = "Bots channel"
        alert.informativeText = "Paste your channel (gbw-…) or any dashboard or wallpaper link with it. "
            + "Leave it empty to show the wallpaper without bots."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 24))
        field.stringValue = Settings.url.fragment.flatMap { Settings.channel(from: "#" + $0) } ?? ""
        field.placeholderString = "gbw-…"
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let input = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let channel = input.isEmpty ? nil : Settings.channel(from: input)
        if !input.isEmpty, channel == nil {
            showAlert("That has no channel in it", "Look for the part that starts with gbw-.")
            return
        }
        let url = Settings.withChannel(channel, on: Settings.url)
        Settings.url = url
        for wallpaper in wallpapers.values {
            if channel == nil { wallpaper.forgetChannel() }
            wallpaper.show(url)
        }
    }

    @objc private func editAddress() {
        let alert = NSAlert()
        alert.messageText = "Wallpaper address"
        alert.informativeText = "The page the wallpaper shows, e.g. https://bodila51.github.io/grokbot-wallpaper/face/#your-topic, "
            + "or your own bot server: http://localhost:8787/face/?key=…"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 24))
        field.stringValue = Settings.url.absoluteString
        field.placeholderString = Settings.defaultURL.absoluteString
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Default")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            guard let url = Settings.address(from: field.stringValue) else {
                showAlert("That doesn't look like a web address",
                          "Use an address like https://bodila51.github.io/grokbot-wallpaper/face/#your-topic or http://localhost:8787/face/?key=…")
                return
            }
            Settings.url = url
        case .alertThirdButtonReturn:
            Settings.resetURL()
        default:
            return
        }
        reloadWallpapers()
    }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            showAlert("Couldn't change Launch at login",
                      "\(error.localizedDescription)\n\nTurn it on in System Settings → General → Login Items.")
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // Run straight from the downloaded disk image (or from a quarantine copy) the login item would point nowhere.
    @objc private func checkInstallPlace() {
        let path = Bundle.main.bundlePath
        guard path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") else { return }
        showAlert("Move the app to Applications",
                  "It is running straight from the downloaded disk image. Drag Grok Bot Wallpaper to the Applications folder "
                  + "and open it from there, otherwise Launch at login won't work.")
    }

    private func showAlert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // An app without a menu bar has no Edit menu, so ⌘V would not paste into the address field without this.
    private func installEditMenu() {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}

enum Settings {
    static let defaultURL = URL(string: "https://bodila51.github.io/grokbot-wallpaper/face/")!

    static var url: URL {
        get { UserDefaults.standard.string(forKey: "wallpaperURL").flatMap { URL(string: $0) } ?? defaultURL }
        set { UserDefaults.standard.set(newValue.absoluteString, forKey: "wallpaperURL") }
    }

    static func resetURL() { UserDefaults.standard.removeObject(forKey: "wallpaperURL") }

    /// Takes what people paste: …/face/#topic (the topic may be any text), with or without https://.
    static func address(from input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        var parts = text.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        if parts.count == 2,
           let topic = (parts[1].removingPercentEncoding ?? parts[1]).addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) {
            parts[1] = topic
        }
        guard let url = URL(string: parts.joined(separator: "#")), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return url
    }

    /// The bots channel in what people paste: gbw-…, or any dashboard, wallpaper or ntfy link with it. A link's own
    /// mailbox (#gbw-…@host, #gbw-…&ntfy=…) is kept. nil: there is no channel in it.
    static func channel(from input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let hashForm = "^[A-Za-z0-9_-]{6,64}(@[^&#\\s]+|&ntfy=[^&#\\s]+)?$"     // = the page's own #<channel> rule
        if let hashStart = text.firstIndex(of: "#") {
            let hash = String(text[text.index(after: hashStart)...])
            if let found = firstMatch(hashForm, in: hash.removingPercentEncoding ?? hash) { return found }
        }
        return firstMatch(hashForm, in: text) ?? firstMatch("gbw-[A-Za-z0-9_-]{6,64}", in: text)
    }

    /// The wallpaper address with this channel as its hash, or with none; the query (a local server's ?key=) stays.
    static func withChannel(_ channel: String?, on base: URL) -> URL {
        let page = base.absoluteString.components(separatedBy: "#")[0]
        guard let channel, !channel.isEmpty else { return URL(string: page) ?? base }
        let hash = channel.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? channel
        return URL(string: page + "#" + hash) ?? base
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        return String(text[range])
    }

    static var matchDesktop: Bool {
        get { UserDefaults.standard.object(forKey: "matchDesktop") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "matchDesktop") }
    }

    /// The user's own desktop picture per display, kept while ours is shown (it survives a crash).
    static func originalDesktop(for id: CGDirectDisplayID) -> URL? {
        (UserDefaults.standard.dictionary(forKey: "originalDesktops")?[String(id)] as? String).flatMap { URL(string: $0) }
    }

    static func setOriginalDesktop(_ url: URL?, for id: CGDirectDisplayID) {
        var all = UserDefaults.standard.dictionary(forKey: "originalDesktops") ?? [:]
        if let url { all[String(id)] = url.absoluteString } else { all[String(id)] = nil }
        UserDefaults.standard.set(all, forKey: "originalDesktops")
    }

    /// "white" or "black" once picked in the menu; nil leaves the page's own choice (?bot=…, its localStorage).
    static var bot: String? {
        get {
            switch UserDefaults.standard.string(forKey: "bot") {
            case "black": return "black"
            case "white": return "white"
            default: return nil
            }
        }
        set { UserDefaults.standard.set(newValue, forKey: "bot") }
    }

    /// `defaults write io.github.bodila51.grokbot-wallpaper pauseWhenCovered -bool false` keeps the eyes fed
    /// even when macOS reports every wallpaper as covered.
    static var pauseWhenCovered: Bool { UserDefaults.standard.object(forKey: "pauseWhenCovered") as? Bool ?? true }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}
