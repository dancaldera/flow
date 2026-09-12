import { execFile, execFileSync } from 'node:child_process'

// Best-effort system-output mute for dictation: whatever is playing (music,
// videos, call audio on speakers) otherwise bleeds into the mic and wrecks
// transcription. Uses the macOS output-mute flag — never the volume level —
// so the user's chosen volume is untouched, and only unmutes what Flow
// itself muted (a pre-existing user mute is left alone).
//
// Never applied to meeting mode: that capture relies on the mic hearing the
// call audio coming out of the speakers.

export function parseOutputMuted(stdout: string): boolean {
	return stdout.trim().toLowerCase().endsWith('true')
}

let mutedByFlow = false

function osa(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('osascript', ['-e', script], { timeout: 2000 }, (error, stdout) =>
			error ? reject(error) : resolve(String(stdout ?? '')),
		)
	})
}

export async function muteSystemAudio(): Promise<void> {
	if (mutedByFlow) return
	try {
		if (parseOutputMuted(await osa('output muted of (get volume settings)'))) return
		await osa('set volume output muted true')
		mutedByFlow = true
		console.log('[flow] system audio muted for dictation')
	} catch (error) {
		console.log(`[flow] system mute unavailable: ${error instanceof Error ? error.message : error}`)
	}
}

export async function restoreSystemAudio(): Promise<void> {
	if (!mutedByFlow) return
	mutedByFlow = false
	try {
		await osa('set volume output muted false')
		console.log('[flow] system audio restored')
	} catch (error) {
		console.log(`[flow] system unmute unavailable: ${error instanceof Error ? error.message : error}`)
	}
}

// Quit path: the process may die before an async spawn finishes, hence sync.
export function restoreSystemAudioSync(): void {
	if (!mutedByFlow) return
	mutedByFlow = false
	try {
		execFileSync('osascript', ['-e', 'set volume output muted false'], { timeout: 2000 })
	} catch {
		// best-effort
	}
}
