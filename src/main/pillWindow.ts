import { BrowserWindow, app, type Rectangle } from 'electron'
import * as path from 'node:path'

// Wide enough for the widest pill state: idle + hover + the meeting teaser
// renders 401px (measured offscreen at 2x from the real index.html + pill.css).
// In a narrower window the pill is squeezed to the window width, the flex items
// shrink, and the overflow-hidden hints clip their own text — at the previous
// 340px the teaser lost its trailing "· click to start".
export const PILL_WINDOW_WIDTH = 420

export function createPillWindow(preloadPath: string, indexPath: string): BrowserWindow {
	const win = new BrowserWindow({
		width: PILL_WINDOW_WIDTH,
		height: 44,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: false,
		resizable: false,
		// NOTE: movable must stay enabled — macOS ignores programmatic
		// setPosition on non-movable windows, which would freeze the pill
		// where it first opened. (Dragging is still impossible: the window
		// forwards all mouse events via setIgnoreMouseEvents.)
		movable: true,
		focusable: false,
		skipTaskbar: true,
		show: false,
		alwaysOnTop: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: preloadPath,
		},
	})

	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	win.setAlwaysOnTop(true, 'floating')
	win.setFullScreenable(false)
	setPillInteractive(win, false)
	if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
	if (process.platform === 'darwin' && app.dock) app.dock.hide()

	void win.loadFile(indexPath)
	return win
}

// Switches the pill between click-through (mouse falls to the app below) and
// interactive (the pill receives clicks). Forwarding stays on in click-through
// mode so mouse moves still reach the renderer.
export function setPillInteractive(win: BrowserWindow, on: boolean): void {
	if (on) win.setIgnoreMouseEvents(false)
	else win.setIgnoreMouseEvents(true, { forward: true })
}

export function resolvePaths(mainDir: string): { preloadPath: string; indexPath: string; historyPath: string } {
	return {
		preloadPath: path.join(mainDir, 'preload.js'),
		indexPath: path.join(mainDir, '..', '..', 'index.html'),
		historyPath: path.join(mainDir, '..', '..', 'history.html'),
	}
}

// Uniform margin between the pill's bottom edge and the screen bottom, in
// every mode: normal, Dock-visible, and fullscreen.
// Anchored to workArea (when not hugging) so the pill tracks the Dock:
// showing, hiding, or resizing it changes the workArea and the caller
// repositions the pill.
const PILL_BOTTOM_GAP = 12

// The Dock reserves space at the BOTTOM of the screen; the menu bar shrinks
// workArea from the top. Comparing bottom edges detects a visible Dock
// without mistaking the menu bar for one: with the Dock auto-hidden,
// workArea still excludes the menu bar but its bottom edge stays flush
// with the screen.
export function isDockVisible(area: Rectangle, bounds: Rectangle): boolean {
	return area.y + area.height < bounds.y + bounds.height - 1
}

// Placement geometry for the main display, in top-left origin points. When it
// comes from the sidecar this is ground truth; Electron's own screen module
// caches metrics and goes stale in long-running background processes.
export type ScreenTruth = {
	fullscreen: boolean
	bounds: Rectangle
	workArea: Rectangle
}

// Parses the sidecar line "<fs> <frameW> <frameH> <visX> <visY> <visW> <visH>".
// The reported usable area is trusted as-is, even over fullscreen: a
// covering window (borderless terminal, overlay, screen sharing) is not a
// fullscreen space, and the Dock is usually still there. Worst case the
// workArea is stale-short and the pill floats slightly — visible, not lost.
export function parseScreenTruth(out: string): ScreenTruth | null {
	const parts = out.trim().split(/\s+/).map(Number)
	if (parts.length !== 7 || parts.some((n) => !Number.isInteger(n))) return null
	const [fs, frameW, frameH, visX, visY, visW, visH] = parts
	const bounds = { x: 0, y: 0, width: frameW, height: frameH }
	return {
		fullscreen: fs === 1,
		bounds,
		workArea: { x: visX, y: visY, width: visW, height: visH },
	}
}

// True when the pill should anchor to the full screen bounds instead of the
// usable area: only when the usable area reaches the screen bottom, i.e. the
// Dock is hidden. The fullscreen flag deliberately plays no part — covering
// windows trip it while the Dock stays visible, and hugging then would park
// the pill behind the Dock.
export function shouldHugBottom(truth: ScreenTruth): boolean {
	return !isDockVisible(truth.workArea, truth.bounds)
}

// Stable key for the current placement inputs; the caller repositions the
// pill only when it changes.
export function placementKey(truth: ScreenTruth, hug: boolean): string {
	const { bounds, workArea } = truth
	return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}|${workArea.x}:${workArea.y}:${workArea.width}:${workArea.height}|${hug ? 1 : 0}`
}

export const PILL_HEIGHT = 44
// macOS pins an auxiliary window's TOP edge to a Dock-clearance line on a
// fullscreen space (measured: the line sits one 44px frame above the
// clearance bottom), so a 44px window can never render at the true screen
// bottom there. Padding the frame upward keeps its top edge above the line
// while the bottom-anchored pill still renders at the true bottom.
const FULLSCREEN_PAD = 100

export function placePillBottomCenter(
	win: BrowserWindow,
	truth: ScreenTruth,
	opts?: { hugBottom?: boolean },
): void {
	const hug = opts?.hugBottom ?? false
	// Hugging uses full bounds: over fullscreen the workArea would be stale
	// (short), so anchoring to it would leave the pill floating.
	const area = hug ? truth.bounds : truth.workArea
	const gap = PILL_BOTTOM_GAP
	const [w] = win.getSize()
	const padded = hug && truth.fullscreen
	const targetHeight = padded ? PILL_HEIGHT + FULLSCREEN_PAD : PILL_HEIGHT
	if (win.getBounds().height !== targetHeight) win.setSize(w, targetHeight)
	const place = () => {
		const y = Math.round(area.y + area.height - targetHeight - gap)
		win.setPosition(Math.round(area.x + (area.width - w) / 2), y, false)
		return y
	}
	const y = place()
	if (padded) {
		// The clamp engages on position: getBounds already reflects it. The
		// clamp moves the frame UP; pad further so the pill still reaches
		// the true bottom.
		const clampedY = win.getBounds().y
		if (clampedY < y) {
			const grown = targetHeight + (y - clampedY) + 8
			win.setSize(w, grown)
			const y2 = Math.round(area.y + area.height - grown - gap)
			win.setPosition(Math.round(area.x + (area.width - w) / 2), y2, false)
		}
	}
}
