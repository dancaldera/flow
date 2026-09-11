import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
	app: { getAppPath: () => '/tmp/flow-focus-test' },
}))

import { type AppRef, resolvePasteTarget } from '../src/main/focus'

const OWN = 1000
const TARGET: AppRef = { pid: 2000, bundleId: 'dev.warp.Warp-Stable' }
const SELF: AppRef = { pid: OWN, bundleId: 'com.flow.dictation' }

describe('resolvePasteTarget', () => {
	it('restores the captured app when Flow is still frontmost after a mouse recording', () => {
		expect(resolvePasteTarget(SELF, OWN, TARGET, true)).toEqual(TARGET)
	})

	it('leaves focus alone when the user switched apps mid-recording', () => {
		expect(resolvePasteTarget({ pid: 3000, bundleId: 'com.apple.finder' }, OWN, TARGET, true)).toBeNull()
	})

	it('never restores for fn/shortcut recordings', () => {
		expect(resolvePasteTarget(SELF, OWN, TARGET, false)).toBeNull()
	})

	it('never restores to itself, an unknown, or a missing app', () => {
		expect(resolvePasteTarget(SELF, OWN, SELF, true)).toBeNull()
		expect(resolvePasteTarget(SELF, OWN, null, true)).toBeNull()
		expect(resolvePasteTarget(null, OWN, TARGET, true)).toBeNull()
	})
})
