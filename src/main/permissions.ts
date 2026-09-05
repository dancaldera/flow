import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, shell, systemPreferences } from 'electron'

export type PermissionState = 'granted' | 'missing' | 'unknown'

export interface PermissionReport {
	microphone: PermissionState
	accessibility: PermissionState
	inputMonitoring?: PermissionState
	axHint?: string
}

/** Microphone: promptable programmatically. */
export function microphoneStatus(): PermissionState {
	if (process.platform !== 'darwin') return 'granted'
	try {
		const status = systemPreferences.getMediaAccessStatus('microphone')
		if (status === 'granted') return 'granted'
		if (status === 'denied' || status === 'restricted') return 'missing'
		return 'unknown'
	} catch {
		return 'unknown'
	}
}

export async function requestMicrophone(): Promise<boolean> {
	if (process.platform !== 'darwin') return true
	try {
		return await systemPreferences.askForMediaAccess('microphone')
	} catch {
		return false
	}
}

/** Accessibility: required for the `fn`-key event tap and Cmd+V paste. */
export function accessibilityStatus(): PermissionState {
	if (process.platform !== 'darwin') return 'granted'
	try {
		return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'missing'
	} catch {
		return 'unknown'
	}
}

/** Shows the system "grant access" dialog, then opens the Settings pane. */
export function promptAccessibility(): void {
	if (process.platform !== 'darwin') return
	try {
		systemPreferences.isTrustedAccessibilityClient(true)
	} catch {
		// dialog display is best-effort; the Settings pane is the fallback
	}
	void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
}

/** Input Monitoring: needed for the CGEventTap `fn` listener on newer macOS. No query API — guide only. */
export function openInputMonitoringSettings(): void {
	void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
}

export function fnHelperPath(): string {
	// Same unpack rule as fullscreenCheckPath in main.ts: spawnSync cannot
	// execute from inside the asar archive.
	return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'swift', 'flow-fn-listener')
}

/**
 * fn-key capability, checked against the process that actually needs trust:
 * the fn-listener helper binary. The Electron main process check
 * (accessibilityStatus) is not used here — in dev it reports the dev
 * launcher's trust, which says nothing about the helper.
 */
export async function fnTapState(
	binary: string = fnHelperPath(),
): Promise<{ state: PermissionState; hint?: string; needsInputMonitoring?: boolean }> {
	if (!fs.existsSync(binary)) {
		return {
			state: 'unknown',
			hint: app?.isPackaged
				? 'Fn-key support is missing from this install — try reinstalling Flow. The ⌥Space shortcut works in the meantime.'
				: 'Fn helper not built — run: swiftc -o swift/flow-fn-listener swift/fn-listener.swift -framework Cocoa. The ⌥Space shortcut works in the meantime.',
		}
	}
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(binary, ['--check'], { timeout: 5000 }, (error) => {
				if (!error) return resolve()
				const err = error as NodeJS.ErrnoException
				const wrapped = new Error(err.message ?? 'fn check failed') as Error & { code?: number }
				wrapped.code = typeof err.code === 'number' ? err.code : undefined
				reject(wrapped)
			})
		})
		return { state: 'granted' }
	} catch (error) {
		const err = error as Error & { code?: number; killed?: boolean }
		if (err.killed) return { state: 'unknown' }
		if (err.code === 3) {
			return {
				state: 'missing',
				needsInputMonitoring: true,
				hint: 'macOS hides <b>real</b> fn key presses behind Input Monitoring — Accessibility alone is not enough. Toggle Flow on in the Input Monitoring list.',
			}
		}
		return { state: 'missing' }
	}
}

export async function report(): Promise<PermissionReport> {
	const fn = await fnTapState()
	return {
		microphone: microphoneStatus(),
		accessibility: fn.state,
		inputMonitoring: fn.needsInputMonitoring ? 'missing' : fn.state === 'granted' ? 'granted' : 'unknown',
		axHint: fn.hint,
	}
}

export function allGranted(r: PermissionReport): boolean {
	return r.microphone === 'granted' && r.accessibility === 'granted'
}
