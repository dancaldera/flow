import { execFile } from 'node:child_process'

// Subtle system-sound feedback for record start/stop — the same cue native
// dictation apps give. Fire-and-forget: afplay is spawned detached and every
// failure is ignored (best-effort, like the tray icon swap).

export type SystemSoundName = 'Tink' | 'Pop'

export function playSystemSound(name: SystemSoundName): void {
	try {
		const child = execFile('/usr/bin/afplay', [`/System/Library/Sounds/${name}.aiff`], () => {})
		child.unref()
	} catch {
		// best-effort
	}
}
