import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

export function focusHelperPath(): string {
	// Same unpack rule as the other sidecars: child processes cannot execute
	// from inside the asar archive.
	return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'swift', 'flow-frontmost')
}

/** A running app, identified by pid plus the bundle id it had when captured. */
export interface AppRef {
	pid: number
	bundleId: string
}

function runHelper(args: string[]): string | null {
	try {
		return execFileSync(focusHelperPath(), args, { timeout: 1500, encoding: 'utf8' }).trim()
	} catch {
		return null
	}
}

/**
 * The frontmost app, or null when unknown. Synchronous: hover-time capture
 * relies on event-loop serialization to read it before activation.
 */
export function frontmostApp(): AppRef | null {
	const out = runHelper(['--print'])
	if (!out) return null
	const [pidText, bundleId] = out.split(' ', 2)
	const pid = Number(pidText)
	if (!Number.isInteger(pid) || pid <= 0 || !bundleId) return null
	return { pid, bundleId }
}

/** Activates the app only if pid still has the captured bundle id. */
export function activateApp(ref: AppRef): boolean {
	return runHelper(['--activate', String(ref.pid), ref.bundleId]) !== null
}

/**
 * Which app should receive the paste, or null to paste wherever focus is.
 * Restores the pre-recording app only when this recording came from the
 * mouse AND Flow itself is still frontmost — the user may have switched
 * apps mid-recording (the latch use case), and their choice always wins.
 */
export function resolvePasteTarget(
	front: AppRef | null,
	ownPid: number,
	captured: AppRef | null,
	mouseInitiated: boolean,
): AppRef | null {
	if (!mouseInitiated || !captured || captured.pid === ownPid) return null
	if (!front || front.pid !== ownPid) return null
	return captured
}
