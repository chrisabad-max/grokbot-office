// swift-tools-version:5.9
// Grok Bot Wallpaper for macOS: the wallpaper page in a desktop-level window, eyes fed from the cursor.
// Built into a .app + .dmg by build.sh (and by .github/workflows/mac.yml on a macOS runner).
import PackageDescription

let package = Package(
    name: "GrokBotWallpaper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "GrokBotWallpaper",
            path: "Sources/GrokBotWallpaper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
    ]
)
