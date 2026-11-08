import AppKit
import WebKit

/// Keeps the system desktop picture equal to the wallpaper. macOS tints the menu bar (and draws Mission Control)
/// from the desktop picture, not from the windows on the desktop, so without this the menu bar shows the colour
/// of the picture hidden under our window. The user's own picture is restored on Quit or when this is turned off.
@MainActor
final class DesktopMatcher: NSObject {
    private var latest: [CGDirectDisplayID: URL] = [:]
    private var pending: [CGDirectDisplayID: URL] = [:]       // set, but not yet seen taking effect
    private var attempts: [CGDirectDisplayID: Int] = [:]
    private var switching = Set<CGDirectDisplayID>()           // the change replaces the user's own picture

    private static var folder: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Grok Bot Wallpaper", isDirectory: true)
    }

    /// Snapshots this display's page and makes it the display's desktop picture.
    func update(_ screen: NSScreen, id: CGDirectDisplayID, from webView: WKWebView) {
        let config = WKSnapshotConfiguration()
        // one pixel per point: a Retina snapshot has 4× the pixels for a tint that is never seen sharp
        config.snapshotWidth = NSNumber(value: Double(screen.frame.width / max(1, screen.backingScaleFactor)))
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self, let image else { return }
            self.apply(image, to: screen, id: id)
        }
    }

    /// A Space switch can show that Space's own picture: put the latest snapshot back, without a new snapshot.
    func reapply(_ screens: [(NSScreen, CGDirectDisplayID)]) {
        for (screen, id) in screens {
            guard let file = latest[id] else { continue }
            let current = NSWorkspace.shared.desktopImageURL(for: screen)
            if let current, DesktopMatcher.same(current, file) { continue }
            remember(current, for: id)
            try? NSWorkspace.shared.setDesktopImageURL(file, for: screen, options: [:])
        }
    }

    /// Gives every display its own picture back, unless the user picked a new one meanwhile.
    func restore(_ screens: [(NSScreen, CGDirectDisplayID)]) {
        pending = [:]
        switching = []
        for (screen, id) in screens {
            guard let original = Settings.originalDesktop(for: id) else { continue }
            if let current = NSWorkspace.shared.desktopImageURL(for: screen), DesktopMatcher.isOurs(current) {
                try? NSWorkspace.shared.setDesktopImageURL(original, for: screen, options: [:])
            }
            Settings.setOriginalDesktop(nil, for: id)
        }
        latest = [:]
    }

    private func apply(_ image: NSImage, to screen: NSScreen, id: CGDirectDisplayID) {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let jpeg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        else { return }
        let current = NSWorkspace.shared.desktopImageURL(for: screen)
        remember(current, for: id)
        if current.map({ !DesktopMatcher.isOurs($0) }) ?? true { switching.insert(id) } else { switching.remove(id) }
        // a new name every time: macOS keeps showing (and caches) a picture whose file name it has seen before
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let file = DesktopMatcher.folder.appendingPathComponent("desktop-\(id)-\(stamp).jpg")
        do {
            try FileManager.default.createDirectory(at: DesktopMatcher.folder, withIntermediateDirectories: true)
            try jpeg.write(to: file, options: .atomic)
            try NSWorkspace.shared.setDesktopImageURL(file, for: screen, options: [:])
            latest[id] = file
            pending[id] = file
            attempts[id] = 0
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(verify), object: nil)
            perform(#selector(verify), with: nil, afterDelay: 2)
            removeOld(for: id, keeping: [file, current])
        } catch {
            NSLog("Grok Bot Wallpaper: desktop picture not set: %@", error.localizedDescription)
        }
    }

    // macOS now and then drops a change without an error: check that it took, set it again (up to 3 times), log it.
    @objc private func verify() {
        let present = Set(NSScreen.screens.compactMap { $0.displayID })
        pending = pending.filter { present.contains($0.key) }
        for screen in NSScreen.screens {
            guard let id = screen.displayID, let file = pending[id] else { continue }
            let tries = attempts[id, default: 0]
            if let current = NSWorkspace.shared.desktopImageURL(for: screen), DesktopMatcher.same(current, file) {
                if switching.remove(id) != nil, let again = DesktopMatcher.twin(of: file) {
                    // Coming from the user's own picture, macOS records the first change yet keeps showing the old
                    // picture (seen on macOS 15); a second change, to a fresh copy, is the one that shows.
                    try? NSWorkspace.shared.setDesktopImageURL(again, for: screen, options: [:])
                    latest[id] = again
                    pending[id] = again
                    attempts[id] = 0
                } else {
                    pending[id] = nil
                }
            } else if tries >= 3 {
                NSLog("Grok Bot Wallpaper: macOS did not take the desktop picture %@", file.path)
                pending[id] = nil
            } else {
                attempts[id] = tries + 1
                try? NSWorkspace.shared.setDesktopImageURL(file, for: screen, options: [:])
            }
        }
        if !pending.isEmpty { perform(#selector(verify), with: nil, afterDelay: 2) }
    }

    // Our older snapshots for this display go, except the one on screen right now.
    private func removeOld(for id: CGDirectDisplayID, keeping keep: [URL?]) {
        let kept = Set(keep.compactMap { $0?.lastPathComponent })
        let files = (try? FileManager.default.contentsOfDirectory(at: DesktopMatcher.folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasPrefix("desktop-\(id)-") && !kept.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    // The latest picture that is not ours is the user's own: that is the one to give back.
    private func remember(_ current: URL?, for id: CGDirectDisplayID) {
        if let current, !DesktopMatcher.isOurs(current) { Settings.setOriginalDesktop(current, for: id) }
    }

    private static func isOurs(_ url: URL) -> Bool {
        url.standardizedFileURL.path.hasPrefix(folder.standardizedFileURL.path)
    }

    private static func twin(of file: URL) -> URL? {
        let copy = file.deletingLastPathComponent().appendingPathComponent(file.deletingPathExtension().lastPathComponent + "-b.jpg")
        do {
            try FileManager.default.copyItem(at: file, to: copy)
            return copy
        } catch {
            return nil
        }
    }

    private static func same(_ a: URL, _ b: URL) -> Bool {
        a.standardizedFileURL.path == b.standardizedFileURL.path
    }
}
