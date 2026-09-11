// Bundle ids of native video-call apps. When one of these is frontmost, the
// pill suggests meeting mode. Browser-based calls (Meet/Teams tabs) are not
// detectable by bundle id — a future step could sniff window titles.
export const MEETING_BUNDLE_IDS = [
	'us.zoom.xos',
	'com.microsoft.teams',
	'com.microsoft.teams2',
	'com.cisco.webexmeetingsapp',
	'com.cisco.webex',
	'com.apple.FaceTime',
	'com.tinyspeck.slackmacgap',
]

const MEETING_SET = new Set(MEETING_BUNDLE_IDS)

/** True when the given frontmost bundle id is a video-call app. */
export function isMeetingApp(bundleId: string | null | undefined): boolean {
	return !!bundleId && MEETING_SET.has(bundleId)
}

/** Seconds since the meeting started, as M:SS for gap markers. */
export function formatTimestamp(totalSeconds: number): string {
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}
