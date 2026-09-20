import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, shell, systemPreferences } from 'electron'

export type PermissionState = 'granted' | 'missing' | 'unknown'

export interface PermissionReport {
	microphone: PermissionState
	accessibility: PermissionState
	inputMonitoring?: PermissionState
	fnHint?: string
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

export type AutomationTarget = 'System Events' | 'Finder'
export const AUTOMATION_TARGETS: AutomationTarget[] = ['System Events', 'Finder']

/** Pure. -1743 → target name parsed from the message, else the first known target mentioned. */
export function automationDenial(message: string): string | null {
	if (!message.includes('-1743') && !message.includes('Not authorized to send Apple events')) return null
	const match = message.match(/to ([A-Z][^.]*?)\./)
	if (match) return match[1]
	return AUTOMATION_TARGETS.find((candidate) => message.includes(candidate)) ?? 'System Events'
}

/** Probes one target — this also triggers the macOS consent prompt when undetermined. */
export async function probeAutomation(target: AutomationTarget): Promise<PermissionState> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFile('osascript', ['-e', `tell application "${target}" to get name`], (error) => (error ? reject(error) : resolve()))
		})
		return 'granted'
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return automationDenial(message) ? 'missing' : 'unknown'
	}
}

export function openAutomationSettings(): void {
	void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
}

export function fnHelperPath(): string {
	// Same unpack rule as fullscreenCheckPath in main.ts: child processes cannot
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
		// Exit 3 means the helper never reached the Accessibility tap test —
		// it bailed on missing Input Monitoring first, so accessibility is unknown.
		if (err.code === 3) {
			return { state: 'unknown', needsInputMonitoring: true }
		}
		return { state: 'missing' }
	}
}

export async function report(): Promise<PermissionReport> {
	const fn = await fnTapState()
	return {
		microphone: microphoneStatus(),
		accessibility: fn.state,
		inputMonitoring: fn.needsInputMonitoring ? 'missing' : fn.state === 'unknown' ? 'unknown' : 'granted',
		fnHint: fn.hint,
	}
}

export function allGranted(r: PermissionReport): boolean {
	return r.microphone === 'granted' && r.accessibility === 'granted'
}
