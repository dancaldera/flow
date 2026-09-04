import { ChildProcess, spawn } from 'node:child_process'
import * as path from 'node:path'
import { BrowserWindow, Tray, app, dialog, globalShortcut, ipcMain, nativeImage } from 'electron'
import { IPC_CHANNELS, type FlowState } from './ipc'
import { insertTextAtCursor } from './main/inserter'
import {
	allGranted,
	fnHelperPath,
	openInputMonitoringSettings,
	promptAccessibility,
	report,
	requestMicrophone,
} from './main/permissions'
import { createPillWindow, placePillBottomCenter, resolvePaths } from './main/pillWindow'
import { PROVIDERS, isProviderConfigured, loadSettings, providerStatus, saveProviderSetup } from './main/settings'
import { SttError, createSttProvider } from './services/stt'

let pill: BrowserWindow | null = null
let onboarding: BrowserWindow | null = null
let tray: Tray | null = null
let recording = false
let chunks: Buffer[] = []
let audioMime = 'audio/webm'
let stopTimer: NodeJS.Timeout | null = null
let secondsTimer: NodeJS.Timeout | null = null
let hideTimer: NodeJS.Timeout | null = null
let seconds = 0
let fnHelper: ChildProcess | null = null
let flowStarted = false

function setState(state: FlowState): void {
	pill?.webContents.send(IPC_CHANNELS.FLOW_STATE, state)
	// Mirror into the menu bar so state is visible even if the pill fails.
	try {
		if (state.phase === 'listening') tray?.setTitle('● Listening…')
		else if (state.phase === 'working') tray?.setTitle('… Working…')
		else if (state.phase === 'error') tray?.setTitle('◉ Flow — error')
		else tray?.setTitle('◉ Flow')
	} catch {
		// tray text is best-effort
	}
}

function showPill(): void {
	if (!pill) return
	if (hideTimer) {
		clearTimeout(hideTimer)
		hideTimer = null
	}
	placePillBottomCenter(pill)
	pill.showInactive()
}

function hidePillSoon(ms = 900): void {
	if (hideTimer) clearTimeout(hideTimer)
	hideTimer = setTimeout(() => {
		hideTimer = null
		if (!recording) pill?.hide()
	}, ms)
}

async function startListening(source: string): Promise<void> {
	if (recording || !pill) return
	console.log(`[flow] start listening (source=${source})`)
	recording = true
	chunks = []
	seconds = 0
	const { maxSeconds } = loadSettings()
	showPill()
	setState({ phase: 'listening', seconds: 0, message: source === 'fn' ? 'Listening… release fn' : 'Listening… press ⌥Space' })
	pill.webContents.send(IPC_CHANNELS.FLOW_START)
	if (stopTimer) clearTimeout(stopTimer)
	stopTimer = setTimeout(() => void stopListening('timeout'), maxSeconds * 1000)
	if (secondsTimer) clearInterval(secondsTimer)
	secondsTimer = setInterval(() => {
		seconds += 1
		setState({ phase: 'listening', seconds })
	}, 1000)
}

async function stopListening(reason: 'release' | 'toggle' | 'timeout' | 'ui'): Promise<void> {
	if (!recording || !pill) return
	console.log(`[flow] stop listening (reason=${reason}, bytes=${Buffer.concat(chunks).length})`)
	recording = false
	if (stopTimer) clearTimeout(stopTimer)
	if (secondsTimer) clearInterval(secondsTimer)
	setState({ phase: 'working', message: 'Transcribing…' })
	pill.webContents.send(IPC_CHANNELS.FLOW_STOP)

	// Wait briefly for the renderer's final audio chunk.
	await new Promise((r) => setTimeout(r, 400))
	let failed = false
	try {
		const audio = Buffer.concat(chunks)
		if (audio.length < 2000) throw new SttError('empty', 'No speech detected.')
		const settings = loadSettings()
		const provider = createSttProvider(settings)
		const ext = audioMime.includes('wav') ? 'wav' : 'webm'
		const text = await provider.transcribe({ audio, filename: `flow.${ext}`, mimeType: audioMime, language: settings.language || undefined })
		await insertTextAtCursor(text)
		setState({ phase: 'idle', message: 'Done' })
	} catch (error) {
		failed = true
		const msg = error instanceof Error ? error.message : String(error)
		console.log(`[flow] transcribe failed: ${msg}`)
		setState({ phase: 'error', message: msg })
		if (reason === 'timeout') void dialog.showMessageBox({ type: 'warning', message: `Flow stopped: ${msg}` })
	} finally {
		chunks = []
		hidePillSoon(failed ? 3500 : 900)
	}
}

function cancelListening(): void {
	if (!recording) return
	recording = false
	chunks = []
	if (stopTimer) clearTimeout(stopTimer)
	if (secondsTimer) clearInterval(secondsTimer)
	pill?.webContents.send(IPC_CHANNELS.FLOW_CANCEL)
	setState({ phase: 'idle', message: 'Cancelled' })
	hidePillSoon(400)
}

function spawnFnHelper(): void {
	// True hold-to-talk on `fn` needs a CGEventTap helper (Electron cannot bind fn alone).
	// The helper prints "down"/"up" lines. Absence is fine: the ⌥Space fallback covers v0.1.
	const binary = fnHelperPath()
	try {
		if (!require('node:fs').existsSync(binary)) {
			fnHelper = null
			console.log('[flow] fn hotkey: helper not built (swift/flow-fn-listener missing) — use ⌥Space. Build: swiftc -o swift/flow-fn-listener swift/fn-listener.swift -framework Cocoa')
			return
		}
		fnHelper = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] })
		console.log('[flow] fn hotkey: native helper active — hold fn to talk')
		let buf = ''
		let stderr = ''
		fnHelper.stdout?.on('data', (d: Buffer) => {
			buf += d.toString()
			let idx: number
			while ((idx = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, idx).trim()
				buf = buf.slice(idx + 1)
				if (line === 'down') void startListening('fn')
				else if (line === 'up') void stopListening('release')
			}
		})
		fnHelper.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString()
		})
		fnHelper.on('exit', (code) => {
			console.log(`[flow] fn helper exited (code=${code}) ${stderr.trim() || '— use ⌥Space fallback'}`)
			fnHelper = null
		})
		fnHelper.on('error', (error) => {
			console.log(`[flow] fn helper failed to start: ${error.message} — use ⌥Space fallback`)
			fnHelper = null
		})
	} catch (error) {
		console.log(`[flow] fn helper unavailable: ${error instanceof Error ? error.message : String(error)} — use ⌥Space fallback`)
		fnHelper = null
	}
}

function showOnboarding(): void {
	if (onboarding && !onboarding.isDestroyed()) {
		onboarding.focus()
		return
	}
	onboarding = new BrowserWindow({
		width: 460,
		height: 640,
		resizable: false,
		alwaysOnTop: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, 'preload.js'),
		},
	})
	void onboarding.loadFile(path.join(__dirname, '..', '..', 'onboarding.html'))
	onboarding.on('closed', () => {
		onboarding = null
	})
}

async function startFlowIfReady(): Promise<void> {
	if (flowStarted) return
	const r = await report()
	const configured = isProviderConfigured()
	console.log(`[flow] setup — provider=${providerStatus().provider} configured=${configured} mic=${r.microphone} accessibility=${r.accessibility}`)
	if (!configured || !allGranted(r)) {
		showOnboarding()
		return
	}
	flowStarted = true
	const { preloadPath, indexPath } = resolvePaths(__dirname)
	pill = createPillWindow(preloadPath, indexPath)
	registerFallbackShortcut()
	spawnFnHelper()
	setState({ phase: 'idle', message: 'Hold fn, speak, release' })
	showPill()
	console.log('[flow] ready — pill shown, waiting for fn / ⌥Space')
	setTimeout(() => {
		if (!recording) pill?.hide()
	}, 5000)
}

function registerFallbackShortcut(): void {
	const ok = globalShortcut.register('Alt+Space', () => {
		if (recording) void stopListening('toggle')
		else void startListening('shortcut')
	})
	const escOk = globalShortcut.register('Escape', () => cancelListening())
	console.log(`[flow] shortcuts: Alt+Space=${ok ? 'registered' : 'FAILED'} Escape=${escOk ? 'registered' : 'FAILED'}`)
	if (!ok) {
		const alt = globalShortcut.register('Control+Space', () => {
			if (recording) void stopListening('toggle')
			else void startListening('shortcut')
		})
		console.log(`[flow] Alt+Space taken, Control+Space=${alt ? 'registered' : 'FAILED'}`)
	}
}

export async function boot(): Promise<void> {
	await app.whenReady()

	tray = new Tray(nativeImage.createEmpty())
	tray.setTitle('◉ Flow')
	tray.setToolTip('Flow — hold fn to dictate')
	tray.setContextMenu(
		require('electron').Menu.buildFromTemplate([
			{ label: 'Hold fn, speak, release', enabled: false },
			{ label: 'Start / stop (⌥Space)', click: () => (recording ? void stopListening('toggle') : void startListening('shortcut')) },
			{ type: 'separator' },
			{ label: 'Setup & permissions…', click: () => showOnboarding() },
			{ label: 'Edit settings.json', click: () => require('electron').shell.openPath(require('electron').app.getPath('userData')) },
			{ label: 'Quit', click: () => app.quit() },
		]),
	)

	ipcMain.on('flow:audio', (_e, payload: { base64: string; mime: string; done: boolean }) => {
		if (!recording && !payload.done) return
		audioMime = payload.mime || audioMime
		if (payload.base64) chunks.push(Buffer.from(payload.base64, 'base64'))
	})
	ipcMain.on('flow:start-ui', () => void startListening('shortcut'))
	ipcMain.on('flow:cancel', () => cancelListening())

	ipcMain.handle('onboarding:get', async () => ({
		permissions: await report(),
		setup: providerStatus(),
		providers: Object.entries(PROVIDERS).map(([id, definition]) => ({ id, ...definition })),
	}))
	ipcMain.handle('onboarding:save-setup', (_event, setup) => saveProviderSetup(setup))
	ipcMain.handle('permissions:request-mic', async () => {
		const granted = await requestMicrophone()
		console.log(`[flow] microphone request → ${granted ? 'granted' : 'denied'}`)
		return granted
	})
	ipcMain.handle('permissions:prompt-accessibility', () => promptAccessibility())
	ipcMain.handle('permissions:open-input-monitoring', () => openInputMonitoringSettings())
	ipcMain.handle('onboarding:complete', async () => {
		await startFlowIfReady()
		return flowStarted
	})
	ipcMain.on('onboarding:close', () => onboarding?.close())
	await startFlowIfReady()
}

void boot()

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
	try {
		fnHelper?.kill()
	} catch {
		// ignore
	}
})
