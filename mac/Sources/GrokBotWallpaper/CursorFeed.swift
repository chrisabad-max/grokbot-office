import AppKit

/// Feeds the cursor to every wallpaper page, so the eyes follow it everywhere, over other apps too.
/// The wallpaper windows ignore the mouse (the desktop icons stay clickable), so the pages never see real
/// moves. Instead the global cursor position is polled 60 times a second and, when it moved, handed to each
/// page as the same `pointermove` a browser would send. Reading NSEvent.mouseLocation needs no Accessibility
/// or Input Monitoring permission: those guard keyboard events and event taps, not the cursor position.
@MainActor
final class CursorFeed: NSObject {
    /// Installed in every page at document start; the feed calls it with page coordinates.
    static let pageHelper = """
        window.__gbwPointer = function (x, y) {
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, screenX: x, screenY: y,
            pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true }));
        };
        """

    var targets: [Wallpaper] = []
    private var timer: Timer?
    private var last: NSPoint?

    func start() {
        guard timer == nil else { return }
        last = nil
        let t = Timer(timeInterval: 1.0 / 60.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        t.tolerance = 0.005
        RunLoop.main.add(t, forMode: .common)       // keeps running while a menu or an alert is open
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// A page (re)loaded: hand it the cursor on the next tick even if the cursor did not move.
    func resend() { last = nil }

    @objc private func tick() {
        let p = NSEvent.mouseLocation
        if p == last { return }
        last = p
        for wallpaper in targets { wallpaper.point(at: p) }
    }
}
