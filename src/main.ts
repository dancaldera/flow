import { ChildProcess, spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron'
import { ERROR_VISIBLE_MS, IPC_CHANNELS, type FlowPhase, type FlowState } from './ipc'
import { insertTextAtCursor } from './main/inserter'
import { checkForUpdates } from './main/updates'
import {
	allGranted,
	fnHelperPath,
	openInputMonitoringSettings,
	promptAccessibility,
	report,
	requestMicrophone,
} from './main/permissions'
import { createPillWindow, isDockVisible, parseScreenTruth, placePillBottomCenter, resolvePaths, type ScreenTruth } from './main/pillWindow'
import { PROVIDERS, STT_PROVIDERS, isProviderConfigured, loadProviderToken, loadSettings, providerStatus, saveProviderSetup } from './main/settings'
import { SttError, createSttProvider } from './services/stt'

let pill: BrowserWindow | null = null
let onboarding: BrowserWindow | null = null
let tray: Tray | null = null
let recording = false
let chunks: Buffer[] = []
let audioMime = 'audio/webm'
let stopTimer: NodeJS.Timeout | null = null
let secondsTimer: NodeJS.Timeout | null = null
let seconds = 0
let fnHelper: ChildProcess | null = null
let flowStarted = false
let currentPhase: FlowPhase = 'idle'
let errorTimer: NodeJS.Timeout | null = null
let lastError: string | null = null

function setState(state: FlowState): void {
	currentPhase = state.phase
	if (errorTimer) {
		clearTimeout(errorTimer)
		errorTimer = null
	}
	pill?.webContents.send(IPC_CHANNELS.FLOW_STATE, state)
	if (state.phase === 'error') {
		lastError = state.message ?? 'Something went wrong'
		refreshTrayMenu()
		// Show the error briefly on the pill, then recover to idle.
		errorTimer = setTimeout(() => {
			errorTimer = null
			if (currentPhase === 'error') setState({ phase: 'idle' })
		}, ERROR_VISIBLE_MS)
	}
	// Mirror into the menu bar as an icon only — words live in the pill
	// and the latest error in the tray menu.
	try {
		if (state.phase === 'listening') tray?.setTitle('●')
		else if (state.phase === 'working') tray?.setTitle('…')
		else if (state.phase === 'error') tray?.setTitle('✕')
		else tray?.setTitle('◉')
	} catch {
		// tray text is best-effort
	}
}

function buildTrayMenu(): Menu {
	const items: Electron.MenuItemConstructorOptions[] = [
		{ label: 'Hold fn, speak, release', enabled: false },
		{ label: 'Start / stop (⌥Space)', click: () => (recording ? void stopListening('toggle') : void startListening('shortcut')) },
		{ label: 'Check for updates…', click: () => void checkForUpdates() },
		{ type: 'separator' },
	]
	if (lastError) {
		items.push({ label: `Last error: ${lastError}`, enabled: false })
		items.push({ type: 'separator' })
	}
	items.push(
		{ label: 'Setup & permissions…', click: () => showOnboarding() },
		{ label: 'How to use Flow…', click: () => showHowToUse() },
		{ label: 'Edit settings.json', click: () => shell.openPath(app.getPath('userData')) },
		{ label: 'Quit', click: () => app.quit() },
	)
	return Menu.buildFromTemplate(items)
}

function refreshTrayMenu(): void {
	try {
		tray?.setContextMenu(buildTrayMenu())
	} catch {
		// tray menu is best-effort
	}
}


function fullscreenCheckPath(): string {
	// electron-builder unpacks binaries next to the asar; spawnSync cannot
	// execute from inside the archive, so swap to app.asar.unpacked when packaged.
	return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'swift', 'flow-fullscreen-check')
}

// Placement ground truth from the sidecar: a fresh Cocoa process reads the
// real display geometry, while THIS process caches metrics and goes stale
// after Dock and fullscreen changes (bounds AND workArea). Falls back to
// Electron's own data only when the binary is missing, so dev still works
// before the sidecar is built.
function activeDisplay(): ScreenTruth {
	try {
		const binary = fullscreenCheckPath()
		if (require('node:fs').existsSync(binary)) {
			const result = spawnSync(binary, [], { timeout: 1500, encoding: 'utf8' })
			const truth = result.status === 0 ? parseScreenTruth(result.stdout) : null
			if (truth) return truth
		}
	} catch {
		// fall through to Electron's (possibly stale) view
	}
	const display = screen.getPrimaryDisplay()
	return { fullscreen: false, bounds: display.bounds, workArea: display.workArea }
}

function pillPlan(): { truth: ScreenTruth; hug: boolean; key: string } {
	const truth = activeDisplay()
	const hug = !isDockVisible(truth.workArea, truth.bounds) || truth.fullscreen
	const { bounds, workArea } = truth
	const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}|${workArea.x}:${workArea.y}:${workArea.width}:${workArea.height}|${hug ? 1 : 0}`
	return { truth, hug, key }
}

function showPill(): void {
	if (!pill) return
	const { truth, hug } = pillPlan()
	placePillBottomCenter(pill, truth, { hugBottom: hug })
	pill.showInactive()
}

let lastPlacement = ''

// macOS exposes no Dock-changed event, so poll: the sidecar re-reads real
// geometry as the Dock shows, hides, or resizes and as fullscreen toggles,
// and the pill follows it.
function followDock(): void {
	if (!pill || pill.isDestroyed()) return
	const { truth, hug, key } = pillPlan()
	if (key !== lastPlacement) {
		lastPlacement = key
		console.log(`[flow] pill placed: hug=${hug}`)
		placePillBottomCenter(pill, truth, { hugBottom: hug })
	}
}

async function startListening(source: string): Promise<void> {
	if (recording || !pill) return
	console.log(`[flow] start listening (source=${source})`)
	recording = true
	chunks = []
	seconds = 0
	const { maxSeconds } = loadSettings()
	showPill()
	setState({ phase: 'listening', seconds: 0 })
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
	try {
		const audio = Buffer.concat(chunks)
		if (audio.length < 2000) throw new SttError('empty', 'No speech detected.')
		const settings = loadSettings()
		const provider = createSttProvider(settings)
		const ext = audioMime.includes('wav') ? 'wav' : 'webm'
		const text = await provider.transcribe({ audio, filename: `flow.${ext}`, mimeType: audioMime, language: settings.language || undefined })
		await insertTextAtCursor(text)
		setState({ phase: 'idle' })
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		console.log(`[flow] transcribe failed: ${msg}`)
		setState({ phase: 'error', message: msg })
		if (reason === 'timeout') void dialog.showMessageBox({ type: 'warning', message: `Flow stopped: ${msg}` })
	} finally {
		chunks = []
		showPill()
	}
}

function cancelListening(): void {
	if (!recording) return
	recording = false
	chunks = []
	if (stopTimer) clearTimeout(stopTimer)
	if (secondsTimer) clearInterval(secondsTimer)
	pill?.webContents.send(IPC_CHANNELS.FLOW_CANCEL)
	setState({ phase: 'idle' })
	showPill()
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

function showHowToUse(): void {
	void dialog.showMessageBox({
		type: 'info',
		title: 'How to use Flow',
		message: 'Hold fn, speak, release — text lands at your cursor.',
		detail: '⌥Space starts/stops as a fallback.\nEsc cancels while listening.\nListening stops automatically at the time limit.\nChange provider, model, or language anytime via Setup & permissions…',
		buttons: ['Got it'],
	})
}

function showOnboarding(): void {
	if (onboarding && !onboarding.isDestroyed()) {
		onboarding.focus()
		return
	}
	onboarding = new BrowserWindow({
		width: 460,
		height: 700,
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
	}
	flowStarted = true
	const { preloadPath, indexPath } = resolvePaths(__dirname)
	pill = createPillWindow(preloadPath, indexPath)
	screen.on('display-metrics-changed', followDock)
	setInterval(followDock, 1500)
	registerFallbackShortcut()
	spawnFnHelper()
	setState({ phase: 'idle' })
	showPill()
	console.log('[flow] ready — pill shown, waiting for fn / ⌥Space')
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
	tray.setTitle('◉')
	tray.setToolTip('Flow — hold fn to dictate')
	tray.setContextMenu(buildTrayMenu())

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
		configuredProviders: STT_PROVIDERS.filter((id) => Boolean(loadProviderToken(id))),
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
