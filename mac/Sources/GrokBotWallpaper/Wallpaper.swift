import AppKit
import WebKit

/// A borderless window that may become key only while the cards are being moved.
final class DesktopWindow: NSWindow {
    var interactive = false
    override var canBecomeKey: Bool { interactive }
}

/// Takes the first click even in an inactive window, so a card can be grabbed right away in drag mode.
final class WallpaperWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The wallpaper on one display: a borderless window between the system wallpaper and the desktop icons,
/// on every Space, filled by a web view with the wallpaper page.
@MainActor
final class Wallpaper: NSObject, WKNavigationDelegate, WKUIDelegate {
    // Above the system wallpaper, below the Finder's icons (the icon level is the desktop level + 20).
    static let wallpaperLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
    // «Move cards»: above the icons, still below every app window.
    static let dragLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)

    let window: DesktopWindow
    let webView: WallpaperWebView
    var onLoad: (() -> Void)?
    private var url: URL
    private var retry: Timer?
    private let scripts: WKUserContentController
    private var forgetting = false

    init(frame: NSRect, url: URL) {
        self.url = url

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                    // the page keeps card positions in localStorage
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addUserScript(Wallpaper.helperScript())
        scripts = config.userContentController
        let web = WallpaperWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false
        web.underPageBackgroundColor = .white
        if #available(macOS 13.3, *) { web.isInspectable = true }   // Safari ▸ Develop, to debug the page

        let win = DesktopWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.isReleasedWhenClosed = false
        win.isRestorable = false
        win.level = Wallpaper.wallpaperLevel
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        win.ignoresMouseEvents = true
        win.canHide = false                                     // "Hide others" must not hide the desktop
        win.hasShadow = false
        win.isOpaque = true
        win.backgroundColor = .white
        win.animationBehavior = .none
        win.acceptsMouseMovedEvents = true
        win.contentView = web

        window = win
        webView = web
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        win.setFrame(frame, display: false)
        win.orderFrontRegardless()
        load()
    }

    func load(_ newURL: URL? = nil) {
        if let newURL { url = newURL }
        cancelRetry()
        webView.load(URLRequest(url: url))
    }

    /// «Reload wallpaper»: the same page fresh from the server, or the new address.
    func refresh(_ newURL: URL) {
        if newURL == url, webView.url != nil {
            cancelRetry()
            webView.reloadFromOrigin()
        } else {
            show(newURL)
        }
    }

    /// A new address from the menu. When only the hash (the bots channel) changes, WebKit would just move to the
    /// anchor, but the page reads its channel on load: so the page changes its own address and reloads, like it
    /// does for Lively's channel setting.
    func show(_ newURL: URL) {
        let hashOnly = newURL.fragment != nil && webView.url.map { Wallpaper.page($0) == Wallpaper.page(newURL) } == true
        url = newURL
        cancelRetry()
        guard hashOnly else { return load() }
        let quoted = newURL.absoluteString.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("location.replace('\(quoted)');location.reload()", completionHandler: nil)
    }

    /// An empty «Bots channel…»: before the next load, wipe the channel the page remembers in localStorage.
    func forgetChannel() {
        scripts.addUserScript(WKUserScript(source: "try{localStorage.removeItem('gbw.feed');localStorage.removeItem('gbw.ntfy')}catch(e){}",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        forgetting = true
    }

    private static func helperScript() -> WKUserScript {
        WKUserScript(source: CursorFeed.pageHelper, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    private static func page(_ u: URL) -> String { u.absoluteString.components(separatedBy: "#")[0] }

    /// The bot's colour picked in the menu, re-applied after every load (the page's own choice if none was picked).
    func applyBot() {
        guard let bot = Settings.bot else { return }
        webView.evaluateJavaScript("window.grokBot&&grokBot.setBot('\(bot)')", completionHandler: nil)
    }

    func setFrame(_ frame: NSRect) {
        window.setFrame(frame, display: true)
    }

    func setInteractive(_ on: Bool) {
        window.interactive = on
        window.ignoresMouseEvents = !on
        window.level = on ? Wallpaper.dragLevel : Wallpaper.wallpaperLevel
        window.orderFrontRegardless()
    }

    var isVisible: Bool { window.occlusionState.contains(.visible) }

    /// The cursor in this page's coordinates (CSS px are points). It may lie off this display:
    /// the eyes then look towards the other screen.
    func point(at p: NSPoint) {
        let f = window.frame
        let js = String(format: "window.__gbwPointer&&__gbwPointer(%.1f,%.1f)", Double(p.x - f.minX), Double(f.maxY - p.y))
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func close() {
        cancelRetry()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        window.orderOut(nil)
        window.close()
    }

    // MARK: loading: a page that fails (no network, the local server not up yet) is retried every 10 s

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        cancelRetry()
        if forgetting {                                        // the wipe ran on this load: back to the helper alone
            forgetting = false
            scripts.removeAllUserScripts()
            scripts.addUserScript(Wallpaper.helperScript())
        }
        applyBot()
        onLoad?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retryLater(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryLater(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load()
    }

    // Links open in the browser; the wallpaper itself never navigates away.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.navigationType == .linkActivated, let link = navigationAction.request.url else { return .allow }
        NSWorkspace.shared.open(link)
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let link = navigationAction.request.url { NSWorkspace.shared.open(link) }
        return nil
    }

    private func retryLater(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }      // a newer load replaced this one
        guard retry == nil else { return }
        retry = Timer.scheduledTimer(timeInterval: 10, target: self, selector: #selector(retryNow), userInfo: nil, repeats: false)
    }

    @objc private func retryNow() {
        retry = nil
        load()
    }

    private func cancelRetry() {
        retry?.invalidate()
        retry = nil
    }
}
