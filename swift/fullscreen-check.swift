import Cocoa

// Ground truth for pill placement, printed as one line:
//   <fullscreen> <frameW> <frameH> <visX> <visY> <visW> <visH>
//
// fullscreen: "1" when a normal window covers the whole main display, else "0".
// frame W/H:  main display size in points.
// vis X/Y/W/H: usable area (visibleFrame) in top-left origin, relative to the
//              main display. Over fullscreen the visibleFrame of a background
//              process is stale (it still excludes the pre-fullscreen Dock),
//              so the caller uses the full frame instead.
//
// A long-running Electron process caches display metrics and goes stale after
// Dock and fullscreen changes; a fresh Cocoa process reads the real values,
// which is why this runs as a sidecar instead of trusting Electron's screen
// module. NSScreen frame stays correct over fullscreen — only visibleFrame
// goes stale.

func isFullscreen(_ main: NSScreen) -> Bool {
	let list = CGWindowListCopyWindowInfo(
		[.optionOnScreenOnly, .excludeDesktopElements],
		kCGNullWindowID
	) as? [[String: Any]] ?? []
	for w in list {
		guard (w[kCGWindowLayer as String] as? Int) == 0,
			let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
			let bw = bounds["Width"], let bh = bounds["Height"],
			let bx = bounds["X"], let by = bounds["Y"]
		else { continue }
		if abs(bw - main.frame.width) <= 2 && abs(bh - main.frame.height) <= 2
			&& abs(bx - main.frame.minX) <= 2 && abs(by - main.frame.minY) <= 2 {
			return true
		}
	}
	return false
}

guard let main = NSScreen.screens.first else {
	print("0 0 0 0 0 0 0")
	exit(0)
}

let f = main.frame
let vf = main.visibleFrame
// Cocoa visibleFrame is bottom-left origin; convert Y to top-left origin.
let visY = f.height - (vf.origin.y + vf.height)
let fs = isFullscreen(main) ? 1 : 0
print("\(fs) \(Int(f.width)) \(Int(f.height)) \(Int(vf.origin.x)) \(Int(visY)) \(Int(vf.width)) \(Int(vf.height))")
