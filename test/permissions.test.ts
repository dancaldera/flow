import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { systemPreferences } from 'electron'

const hoisted = vi.hoisted(() => ({
	userData: '/tmp/flow-permissions-test',
	mediaStatus: 'granted' as 'granted' | 'unknown' | 'not-determined' | 'denied' | 'restricted',
	axTrusted: true,
}))

vi.mock('electron', () => ({
	app: { getAppPath: () => hoisted.userData, getPath: () => hoisted.userData },
	shell: { openExternal: vi.fn() },
	systemPreferences: {
		getMediaAccessStatus: vi.fn(() => hoisted.mediaStatus),
		isTrustedAccessibilityClient: vi.fn(() => hoisted.axTrusted),
	},
}))

import { accessibilityStatus, allGranted, automationDenial, microphoneStatus, report } from '../src/main/permissions'

/** An executable stand-in for the fn helper whose --check exits `code`. */
function fakeHelper(code: number): void {
	const dir = path.join(hoisted.userData, 'swift')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'flow-fn-listener'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 })
}

// The status checks short-circuit to 'granted' off macOS; CI runs on Linux.
const realPlatform = process.platform

beforeEach(() => {
	Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
	hoisted.mediaStatus = 'granted'
	hoisted.axTrusted = true
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
})

afterEach(() => {
	Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
	vi.mocked(systemPreferences.getMediaAccessStatus).mockImplementation(() => hoisted.mediaStatus)
	vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockImplementation(() => hoisted.axTrusted)
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
})

describe('microphoneStatus', () => {
	it('maps the macOS media access status', () => {
		hoisted.mediaStatus = 'granted'
		expect(microphoneStatus()).toBe('granted')
		hoisted.mediaStatus = 'denied'
		expect(microphoneStatus()).toBe('missing')
		hoisted.mediaStatus = 'restricted'
		expect(microphoneStatus()).toBe('missing')
		hoisted.mediaStatus = 'not-determined'
		expect(microphoneStatus()).toBe('unknown')
	})

	it('reports unknown when the query throws', () => {
		vi.mocked(systemPreferences.getMediaAccessStatus).mockImplementation(() => {
			throw new Error('boom')
		})
		expect(microphoneStatus()).toBe('unknown')
	})
})

describe('accessibilityStatus', () => {
	it('maps the trust check', () => {
		hoisted.axTrusted = true
		expect(accessibilityStatus()).toBe('granted')
		hoisted.axTrusted = false
		expect(accessibilityStatus()).toBe('missing')
	})

	it('reports unknown when the check throws', () => {
		vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockImplementation(() => {
			throw new Error('boom')
		})
		expect(accessibilityStatus()).toBe('unknown')
	})
})

describe('report', () => {
	it('maps a denied fn helper to missing accessibility and input monitoring', async () => {
		fakeHelper(3)
		hoisted.mediaStatus = 'granted'
		const r = await report()
		expect(r.microphone).toBe('granted')
		expect(r.accessibility).toBe('missing')
		expect(r.inputMonitoring).toBe('missing')
		expect(r.axHint).toMatch(/Input Monitoring/)
	})

	it('maps a working helper to granted', async () => {
		fakeHelper(0)
		const r = await report()
		expect(r.accessibility).toBe('granted')
		expect(r.inputMonitoring).toBe('granted')
	})

	it('maps a missing helper to unknown with a hint', async () => {
		const r = await report()
		expect(r.accessibility).toBe('unknown')
		expect(r.inputMonitoring).toBe('unknown')
		expect(r.axHint).toBeTruthy()
	})
})

describe('allGranted', () => {
	it('requires both microphone and accessibility', () => {
		expect(allGranted({ microphone: 'granted', accessibility: 'granted' })).toBe(true)
		expect(allGranted({ microphone: 'missing', accessibility: 'granted' })).toBe(false)
		expect(allGranted({ microphone: 'granted', accessibility: 'missing' })).toBe(false)
		expect(allGranted({ microphone: 'unknown', accessibility: 'unknown' })).toBe(false)
	})
})

describe('automationDenial', () => {
	it('parses the target from a -1743 denial', () => {
		expect(automationDenial('144:148: execution error: Not authorized to send Apple events to System Events. (-1743)')).toBe('System Events')
	})

	it('falls back to a known target mentioned in the message', () => {
		expect(automationDenial('Finder got an error: User canceled. (-1743)')).toBe('Finder')
	})

	it('returns null for unrelated errors', () => {
		expect(automationDenial('osascript: no such file')).toBeNull()
		expect(automationDenial('')).toBeNull()
	})
})
