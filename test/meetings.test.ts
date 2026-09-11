import { describe, expect, it } from 'vitest'
import { MEETING_BUNDLE_IDS, formatTimestamp, isMeetingApp } from '../src/main/meetings'

describe('isMeetingApp', () => {
	it('matches the native video-call apps by bundle id', () => {
		expect(isMeetingApp('us.zoom.xos')).toBe(true)
		expect(isMeetingApp('com.microsoft.teams')).toBe(true)
		expect(isMeetingApp('com.microsoft.teams2')).toBe(true)
		expect(isMeetingApp('com.cisco.webexmeetingsapp')).toBe(true)
		expect(isMeetingApp('com.cisco.webex')).toBe(true)
		expect(isMeetingApp('com.apple.FaceTime')).toBe(true)
		expect(isMeetingApp('com.tinyspeck.slackmacgap')).toBe(true)
	})

	it('rejects everything else, including empty and missing ids', () => {
		expect(isMeetingApp('com.apple.finder')).toBe(false)
		expect(isMeetingApp('dev.warp.Warp-Stable')).toBe(false)
		expect(isMeetingApp('us.zoom.xos.evil')).toBe(false)
		expect(isMeetingApp('')).toBe(false)
		expect(isMeetingApp(null)).toBe(false)
		expect(isMeetingApp(undefined)).toBe(false)
	})

	it('keeps the documented set in sync with the matcher', () => {
		for (const id of MEETING_BUNDLE_IDS) expect(isMeetingApp(id)).toBe(true)
		expect(MEETING_BUNDLE_IDS.length).toBeGreaterThan(0)
	})
})

describe('formatTimestamp', () => {
	it('formats seconds as M:SS', () => {
		expect(formatTimestamp(0)).toBe('0:00')
		expect(formatTimestamp(65)).toBe('1:05')
		expect(formatTimestamp(3600)).toBe('60:00')
	})
})
