import { describe, expect, it } from 'vitest'
import { isDockVisible, parseScreenTruth, placePillBottomCenter, placementKey, setPillInteractive, shouldHugBottom, type ScreenTruth } from '../src/main/pillWindow'

// macOS pins the top edge of an auxiliary window at y=784 on a fullscreen
// space while the Dock is enabled (measured on a 1440x900 display, Dock
// height 84); emulate that clamp so the adaptive padding is exercised.
const CLAMP_LINE = 784

function fakeWindow(width = 340, height = 44, clampLine = Number.POSITIVE_INFINITY) {
	return {
		size: [width, height] as [number, number],
		pos: [0, 0] as [number, number],
		getSize() {
			return this.size
		},
		getBounds() {
			return { x: this.pos[0], y: this.pos[1], width: this.size[0], height: this.size[1] }
		},
		setSize(w: number, h: number) {
			this.size = [w, h]
		},
		setPosition(x: number, y: number) {
			this.pos = [x, Math.min(y, clampLine)]
		},
		ignored: [] as Array<{ ignore: boolean; options?: unknown }>,
		setIgnoreMouseEvents(ignore: boolean, options?: unknown) {
			this.ignored.push({ ignore, options })
		},
	}
}

function truth(overrides?: Partial<ScreenTruth>): ScreenTruth {
	return {
		fullscreen: false,
		bounds: { x: 0, y: 0, width: 1440, height: 900 },
		workArea: { x: 0, y: 25, width: 1440, height: 875 },
		...overrides,
	}
}

describe('placePillBottomCenter', () => {
	it('sits just above a visible Dock', () => {
		const win = fakeWindow()
		placePillBottomCenter(win as never, truth())
		expect(win.pos[0]).toBe(Math.round((1440 - 340) / 2))
		// workArea bottom minus pill height minus the bottom gap.
		expect(win.pos[1]).toBe(25 + 875 - 44 - 12)
	})

	it('hugs the bottom edge when asked, clearing the Dock gap', () => {
		const plain = fakeWindow()
		placePillBottomCenter(plain as never, truth({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }))
		expect(plain.pos).toEqual([Math.round((1440 - 340) / 2), 900 - 44 - 12])
	})

	it('grows the frame upward over fullscreen so the pill reaches the true bottom', () => {
		// The clamp pins the top edge at 784; the padded frame (144) asks
		// y=756, keeps it, and the bottom-anchored pill renders at 856..900.
		const win = fakeWindow(340, 44, CLAMP_LINE)
		placePillBottomCenter(
			win as never,
			truth({ fullscreen: true, workArea: { x: 0, y: 30, width: 1440, height: 786 } }),
			{ hugBottom: true },
		)
		expect(win.size).toEqual([340, 144])
		expect(win.pos).toEqual([Math.round((1440 - 340) / 2), 900 - 144 - 12])
	})

	it('pads past the clamp line when the clearance is larger', () => {
		// A taller clamp line (bigger Dock) pushes the first ask up; the
		// adaptive re-pad must still land the frame bottom at the true bottom.
		const tight = fakeWindow(340, 44, 700)
		placePillBottomCenter(
			tight as never,
			truth({ fullscreen: true, workArea: { x: 0, y: 30, width: 1440, height: 786 } }),
			{ hugBottom: true },
		)
		expect(tight.size[1]).toBeGreaterThan(144)
		expect(tight.pos[1] + tight.size[1]).toBe(900 - 12)
	})
})

describe('isDockVisible', () => {
	it('detects a visible Dock reserving bottom space', () => {
		expect(isDockVisible({ x: 0, y: 25, width: 1440, height: 875 - 84 }, { x: 0, y: 0, width: 1440, height: 900 })).toBe(true)
	})

	it('does not mistake the menu bar for a Dock (auto-hidden Dock)', () => {
		// Real numbers: Dock auto-hidden leaves workArea = menu bar only,
		// bottom edge flush with the screen.
		expect(isDockVisible({ x: 0, y: 25, width: 1440, height: 875 }, { x: 0, y: 0, width: 1440, height: 900 })).toBe(false)
	})

	it('does not mistake a stale fullscreen workArea for a hidden Dock', () => {
		// Background processes see the pre-fullscreen workArea; bottom edge
		// is above the screen bottom, so a Dock is (stale-)detected and the
		// caller must consult the fullscreen check.
		expect(isDockVisible({ x: 0, y: 30, width: 1440, height: 786 }, { x: 0, y: 0, width: 1440, height: 900 })).toBe(true)
	})
})

describe('parseScreenTruth', () => {
	it('parses the sidecar line into bounds and workArea', () => {
		// Real sidecar output: not fullscreen, 1440x900 display, usable area
		// below the menu bar and above the Dock.
		const t = parseScreenTruth('0 1440 900 0 30 1440 786')
		expect(t).toEqual({
			fullscreen: false,
			bounds: { x: 0, y: 0, width: 1440, height: 900 },
			workArea: { x: 0, y: 30, width: 1440, height: 786 },
		})
	})

	it('keeps the reported usable area as workArea over fullscreen', () => {
		// A covering window is not a fullscreen space: discarding the fresh
		// usable area hid the pill behind still-visible Docks. Trust it.
		const t = parseScreenTruth('1 1440 900 0 30 1440 786')
		expect(t?.fullscreen).toBe(true)
		expect(t?.workArea).toEqual({ x: 0, y: 30, width: 1440, height: 786 })
	})

	it('rejects malformed output', () => {
		expect(parseScreenTruth('garbage')).toBeNull()
		expect(parseScreenTruth('1 1440')).toBeNull()
		expect(parseScreenTruth('1 1440 900 0 30 NaN 786')).toBeNull()
		expect(parseScreenTruth('')).toBeNull()
	})
})

describe('shouldHugBottom', () => {
	it('anchors to the work area when the Dock is visible', () => {
		expect(shouldHugBottom(truth({ workArea: { x: 0, y: 25, width: 1440, height: 875 - 84 } }))).toBe(false)
	})

	it('hugs the screen bottom when the Dock is hidden', () => {
		// Menu bar only: workArea bottom flush with the screen bottom.
		expect(shouldHugBottom(truth())).toBe(true)
	})

	it('does not hug over fullscreen when the workArea shows a Dock', () => {
		// Covering windows trip the fullscreen flag while the Dock stays
		// visible; hugging would park the pill behind it. Worst case the
		// workArea is stale-short and the pill floats slightly.
		expect(shouldHugBottom(truth({ fullscreen: true, workArea: { x: 0, y: 30, width: 1440, height: 786 } }))).toBe(false)
	})
})

describe('placementKey', () => {
	it('changes when geometry or hug mode changes, and only then', () => {
		const base = truth()
		expect(placementKey(base, false)).toBe(placementKey(truth(), false))
		expect(placementKey(base, false)).not.toBe(placementKey(base, true))
		expect(placementKey(base, false)).not.toBe(
			placementKey(truth({ workArea: { x: 0, y: 25, width: 1440, height: 791 } }), false),
		)
	})
})

describe('setPillInteractive', () => {
	it('takes clicks when on, click-through with forward when off', () => {
		const win = fakeWindow()
		setPillInteractive(win as never, true)
		setPillInteractive(win as never, false)
		expect(win.ignored).toEqual([{ ignore: false, options: undefined }, { ignore: true, options: { forward: true } }])
	})
})

describe('covering window with a visible Dock (regression)', () => {
	it('sits above the Dock instead of hugging the screen bottom', () => {
		// Captured on a 1440x900 display: a borderless window covers the
		// screen (fullscreen=1) while the Dock is visible (usable area
		// excludes 76px at the bottom). A covering window is not a
		// fullscreen space — the pill must clear the Dock top (y=824).
		const t = parseScreenTruth('1 1440 900 0 30 1440 794')
		expect(t?.fullscreen).toBe(true)
		expect(t && shouldHugBottom(t)).toBe(false)
		const win = fakeWindow()
		placePillBottomCenter(win as never, t!, { hugBottom: shouldHugBottom(t!) })
		expect(win.pos[1] + win.size[1]).toBeLessThanOrEqual(824 - 12)
	})
})
