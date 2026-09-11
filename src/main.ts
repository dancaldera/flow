import { ChildProcess, execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { BrowserWindow, Menu, Notification, Tray, app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron'
import { ERROR_VISIBLE_MS, IPC_CHANNELS, type FlowPhase, type FlowState } from './ipc'
import { activateApp, frontmostApp, frontmostAppAsync, resolvePasteTarget, type AppRef } from './main/focus'
import { type HistoryListOptions, clearHistory, getHistoryDbPath, listTranscriptions, openHistoryDb, recordTranscription } from './main/history'
import { insertTextAtCursor } from './main/inserter'
import { formatTimestamp, isMeetingApp } from './main/meetings'
import { checkForUpdates } from './main/updates'
import {
	allGranted,
	fnHelperPath,
	openInputMonitoringSettings,
	promptAccessibility,
	report,
	requestMicrophone,
} from './main/permissions'
import { createPillWindow, parseScreenTruth, placePillBottomCenter, placementKey, resolvePaths, setPillInteractive, shouldHugBottom, type ScreenTruth } from './main/pillWindow'
import { PROVIDERS, STT_PROVIDERS, isProviderConfigured, llmStatus, loadProviderToken, loadSettings, providerStatus, resolveLlmSetup, resolveProviderSetup, saveLlmSetup, saveProviderSetup } from './main/settings'
import { createLlmClient } from './services/llm'
import { SttError, createSttProvider, testSttProvider } from './services/stt'

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
let updating = false
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
		{ label: 'Start / stop (⌥Space)', click: () => (meetingRecording ? void stopMeeting('ui') : recording ? void stopListening('toggle') : void startListening('shortcut')) },
		{ type: 'separator' },
	]
	if (lastError) {
		items.push({ label: `Last error: ${lastError}`, enabled: false })
		items.push({ type: 'separator' })
	}
	items.push({
		label: 'Check for updates…',
		click: () => {
			if (updating) return
			updating = true
			if (recording) cancelListening()
			void checkForUpdates((pct) => setState({ phase: 'working', message: `Updating… ${pct}%` })).finally(() => {
				updating = false
				if (currentPhase === 'working') setState({ phase: 'idle' })
			})
		},
	})
	items.push(
		{ label: 'Setup & permissions…', click: () => showOnboarding() },
		{ label: 'How to use Flow…', click: () => showHowToUse() },
		{ label: 'History…', click: () => openHistoryWindow() },
		{ label: 'Edit settings.json', click: () => shell.openPath(app.getPath('userData')) },
		{ label: 'Quit', click: () => app.quit() },
	)
	return Menu.buildFromTemplate(items)
}

let historyWin: BrowserWindow | null = null
let historyDb: DatabaseSync | null = null
let lastStartSource = ''

function openHistoryWindow(): void {
	if (historyWin && !historyWin.isDestroyed()) {
		historyWin.focus()
		return
	}
	const { preloadPath, historyPath } = resolvePaths(__dirname)
	historyWin = new BrowserWindow({
		width: 520,
		height: 640,
		minWidth: 360,
		minHeight: 400,
		title: 'Flow History',
		backgroundColor: '#1e1e20',
		webPreferences: { preload: preloadPath },
		show: false,
	})
	void historyWin.loadFile(historyPath)
	historyWin.once('ready-to-show', () => historyWin?.show())
	historyWin.on('closed', () => {
		historyWin = null
	})
}

function refreshTrayMenu(): void {
	try {
		tray?.setContextMenu(buildTrayMenu())
	} catch {
		// tray menu is best-effort
	}
}


function fullscreenCheckPath(): string {
	// electron-builder unpacks binaries next to the asar; child processes cannot
	// execute from inside the archive, so swap to app.asar.unpacked when packaged.
	return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'swift', 'flow-fullscreen-check')
}

// Placement ground truth comes from the sidecar: a fresh Cocoa process reads
// the real display geometry, while THIS process caches metrics and goes stale
// after Dock and fullscreen changes (bounds AND workArea). The sidecar is
// read asynchronously — spawning a Cocoa process takes ~100ms and must not
// block the event loop — with the last good reading (or Electron's own data,
// so dev still works before the sidecar is built) covering the gap.
let cachedTruth: ScreenTruth | null = null
let sidecarInFlight = false

function electronTruth(): ScreenTruth {
	const display = screen.getPrimaryDisplay()
	return { fullscreen: false, bounds: display.bounds, workArea: display.workArea }
}

function readSidecarTruth(): Promise<ScreenTruth | null> {
	return new Promise((resolve) => {
		try {
			const binary = fullscreenCheckPath()
			if (!fs.existsSync(binary)) return resolve(null)
			execFile(binary, [], { timeout: 1500 }, (error, stdout) => {
				if (error) return resolve(null)
				resolve(parseScreenTruth(String(stdout ?? '')))
			})
		} catch {
			resolve(null)
		}
	})
}

let lastPlacement = ''

// Single placement flow for showing, polling, and display changes: refresh
// the sidecar truth, then reposition only when the placement inputs changed.
// At most one sidecar read is ever outstanding; concurrent ticks reuse its
// result instead of queueing redundant spawns.
async function updatePillPlacement(): Promise<void> {
	if (!pill || pill.isDestroyed() || sidecarInFlight) return
	sidecarInFlight = true
	try {
		cachedTruth = (await readSidecarTruth()) ?? cachedTruth ?? electronTruth()
		if (!pill || pill.isDestroyed()) return
		const hug = shouldHugBottom(cachedTruth)
		const key = placementKey(cachedTruth, hug)
		if (key !== lastPlacement) {
			lastPlacement = key
			console.log(`[flow] pill placed: hug=${hug}`)
			placePillBottomCenter(pill, cachedTruth, { hugBottom: hug })
		}
	} finally {
		sidecarInFlight = false
	}
}

function showPill(): void {
	if (!pill) return
	pill.showInactive()
	void updatePillPlacement()
}

let pillInteractive = false
let appBeforeMouse: AppRef | null = null
let mouseInitiated = false
let focusRefresh: NodeJS.Timeout | null = null

// Clicking the pill activates Flow, stealing frontmost status from the app
// the user dictates into — so the pre-click app is captured (synchronously:
// event-loop serialization guarantees this read lands before activation)
// and re-activated before pasting. Refreshed while hovered in case the user
// switches apps mid-hover via keyboard.
function capturePasteTarget(): void {
	const front = frontmostApp()
	if (front && front.pid !== process.pid) appBeforeMouse = front
}

// The renderer detects hover (forwarded mouse moves arrive even in
// click-through mode) and reports it; main just mirrors the mode. Deduped:
// redundant setIgnoreMouseEvents calls are skipped.
function applyPillInteractive(on: boolean): void {
	if (on === pillInteractive || !pill || pill.isDestroyed()) return
	pillInteractive = on
	console.log(`[flow] pill interactive: ${on ? 'on' : 'off'}`)
	setPillInteractive(pill, on)
	if (focusRefresh) {
		clearInterval(focusRefresh)
		focusRefresh = null
	}
	if (on) {
		focusRefresh = setInterval(capturePasteTarget, 1000)
	}
}

async function ensurePasteTarget(): Promise<void> {
	const target = resolvePasteTarget(frontmostApp(), process.pid, appBeforeMouse, mouseInitiated)
	if (!target) return
	console.log(`[flow] restoring paste target: ${target.bundleId}`)
	if (activateApp(target)) await new Promise((r) => setTimeout(r, 400))
}

// macOS exposes no Dock-changed event, so poll: the sidecar re-reads real
// geometry as the Dock shows, hides, or resizes and as fullscreen toggles,
// and the pill follows it.
function followDock(): void {
	if (!pill || pill.isDestroyed()) return
	void updatePillPlacement()
}

async function startListening(source: string): Promise<void> {
	if (recording || meetingRecording || updating || !pill) return
	console.log(`[flow] start listening (source=${source})`)
	recording = true
	mouseInitiated = source === 'mouse'
	lastStartSource = source
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
		if (historyDb && text) {
			try {
				recordTranscription(historyDb, { text, provider: settings.provider, source: lastStartSource })
			} catch (error) {
				console.log(`[flow] history record failed: ${error instanceof Error ? error.message : error}`)
			}
		}
		await ensurePasteTarget()
		await insertTextAtCursor(text)
		setState({ phase: 'idle' })
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		console.log(`[flow] transcribe failed: ${msg}`)
		setState({ phase: 'error', message: msg })
		if (reason === 'timeout') void dialog.showMessageBox({ type: 'warning', message: `Flow stopped: ${msg}` })
	} finally {
		chunks = []
		mouseInitiated = false
		showPill()
	}
}

function cancelListening(): void {
	// Esc during a meeting stops and SAVES: meeting audio is irreplaceable,
	// while a snippet can simply be re-dictated.
	if (meetingRecording) {
		void stopMeeting('ui')
		return
	}
	if (!recording) return
	recording = false
	mouseInitiated = false
	chunks = []
	if (stopTimer) clearTimeout(stopTimer)
	if (secondsTimer) clearInterval(secondsTimer)
	pill?.webContents.send(IPC_CHANNELS.FLOW_CANCEL)
	setState({ phase: 'idle' })
	showPill()
}

// Meeting mode: continuous mic capture while a video call is frontmost,
// transcribed in minute segments, summarized at the end when an LLM key is
// configured. Recording is always explicit — the pill only ever suggests.
const MEETING_POLL_MS = 5000
const MEETING_SEGMENT_MS = 60000
const MEETING_MAX_MS = 3 * 3600 * 1000

let meetingRecording = false
let meetingSuggest = false
let meetingPollInFlight = false
let meetingChunks: Buffer[] = []
let meetingSegments: string[] = []
let meetingChain: Promise<void> = Promise.resolve()
let meetingSeconds = 0
let meetingSegmentStart = 0
let meetingStopTimer: NodeJS.Timeout | null = null
let meetingSecondsTimer: NodeJS.Timeout | null = null
let meetingSegmentTimer: NodeJS.Timeout | null = null

function notify(title: string, body: string): void {
	try {
		new Notification({ title: `Flow — ${title}`, body }).show()
	} catch {
		// notifications are best-effort
	}
}

async function pollMeetingSuggest(): Promise<void> {
	if (!pill || pill.isDestroyed() || meetingPollInFlight) return
	if (recording || meetingRecording || updating) return
	meetingPollInFlight = true
	try {
		const front = await frontmostAppAsync()
		const suggest = !!front && isMeetingApp(front.bundleId)
		if (suggest !== meetingSuggest) {
			meetingSuggest = suggest
			console.log(`[flow] meeting suggest: ${suggest ? `on (${front?.bundleId})` : 'off'}`)
			pill?.webContents.send(IPC_CHANNELS.MEETING_SUGGEST, suggest)
		}
	} finally {
		meetingPollInFlight = false
	}
}

async function startMeeting(): Promise<void> {
	if (meetingRecording || recording || updating || !pill) return
	if (!isProviderConfigured()) {
		setState({ phase: 'error', message: 'Configure transcription first (Setup & permissions…)' })
		return
	}
	console.log('[flow] meeting start')
	meetingRecording = true
	meetingChunks = []
	meetingSegments = []
	meetingChain = Promise.resolve()
	meetingSeconds = 0
	meetingSegmentStart = 0
	lastStartSource = 'meeting'
	showPill()
	pill.webContents.send(IPC_CHANNELS.MEETING_ACTIVE, true)
	setState({ phase: 'listening', seconds: 0, message: 'Meeting…' })
	pill.webContents.send(IPC_CHANNELS.FLOW_START)
	if (meetingStopTimer) clearTimeout(meetingStopTimer)
	meetingStopTimer = setTimeout(() => void stopMeeting('timeout'), MEETING_MAX_MS)
	if (meetingSecondsTimer) clearInterval(meetingSecondsTimer)
	meetingSecondsTimer = setInterval(() => {
		meetingSeconds += 1
		setState({ phase: 'listening', seconds: meetingSeconds, message: 'Meeting…' })
	}, 1000)
	if (meetingSegmentTimer) clearInterval(meetingSegmentTimer)
	meetingSegmentTimer = setInterval(() => flushMeetingSegment(), MEETING_SEGMENT_MS)
}

// Slices the buffered audio into a segment and transcribes it. Segments run
// strictly in order so the transcript never scrambles.
function flushMeetingSegment(): void {
	if (!meetingChunks.length) {
		meetingSegmentStart = meetingSeconds
		return
	}
	const audio = Buffer.concat(meetingChunks)
	meetingChunks = []
	const fromSecond = meetingSegmentStart
	const toSecond = meetingSeconds
	meetingSegmentStart = toSecond
	meetingChain = meetingChain.then(() => transcribeMeetingSegment(audio, fromSecond, toSecond)).catch(() => {})
}

async function transcribeMeetingSegment(audio: Buffer, fromSecond: number, toSecond: number): Promise<void> {
	try {
		if (audio.length < 2000) return
		const settings = loadSettings()
		const provider = createSttProvider(settings)
		const ext = audioMime.includes('wav') ? 'wav' : 'webm'
		const text = await provider.transcribe({ audio, filename: `flow-meeting.${ext}`, mimeType: audioMime, language: settings.language || undefined })
		meetingSegments.push(text)
	} catch (error) {
		if (error instanceof SttError && error.kind === 'empty') return
		console.log(`[flow] meeting segment failed: ${error instanceof Error ? error.message : error}`)
		meetingSegments.push(`[gap ${formatTimestamp(fromSecond)}–${formatTimestamp(toSecond)}]`)
	}
}

async function stopMeeting(reason: 'ui' | 'timeout'): Promise<void> {
	if (!meetingRecording || !pill) return
	console.log(`[flow] meeting stop (reason=${reason}, seconds=${meetingSeconds})`)
	meetingRecording = false
	if (meetingStopTimer) clearTimeout(meetingStopTimer)
	if (meetingSecondsTimer) clearInterval(meetingSecondsTimer)
	if (meetingSegmentTimer) clearInterval(meetingSegmentTimer)
	pill.webContents.send(IPC_CHANNELS.MEETING_ACTIVE, false)
	setState({ phase: 'working', message: 'Finishing meeting…' })
	pill.webContents.send(IPC_CHANNELS.FLOW_STOP)

	// Wait briefly for the renderer's final audio chunk, then drain the queue.
	await new Promise((r) => setTimeout(r, 400))
	flushMeetingSegment()
	await meetingChain
	meetingChunks = []
	const transcript = meetingSegments.join('\n').trim()
	meetingSegments = []
	if (!transcript) {
		setState({ phase: 'idle' })
		showPill()
		return
	}
	const settings = loadSettings()
	if (historyDb) {
		try {
			recordTranscription(historyDb, { text: transcript, provider: settings.provider, source: 'meeting' })
		} catch (error) {
			console.log(`[flow] meeting history failed: ${error instanceof Error ? error.message : error}`)
		}
	}
	const llm = createLlmClient(settings)
	if (!llm) {
		notify('Meeting transcribed', 'Transcript saved to History. Add an LLM key in Setup for summaries.')
		setState({ phase: 'idle' })
		showPill()
		return
	}
	setState({ phase: 'working', message: 'Summarizing…' })
	try {
		const summary = await llm.summarize(transcript)
		if (historyDb) {
			try {
				recordTranscription(historyDb, { text: `Summary: ${summary}`, provider: 'llm', source: 'meeting' })
			} catch (error) {
				console.log(`[flow] summary history failed: ${error instanceof Error ? error.message : error}`)
			}
		}
		notify('Meeting summarized', 'Transcript and summary saved to History.')
	} catch (error) {
		console.log(`[flow] summarize failed: ${error instanceof Error ? error.message : error}`)
		notify('Meeting transcribed', 'Summary failed — transcript saved to History.')
	}
	setState({ phase: 'idle' })
	showPill()
}

function spawnFnHelper(): void {
	if (fnHelper) return

	// True hold-to-talk on `fn` needs a CGEventTap helper (Electron cannot bind fn alone).
	// The helper prints "down"/"up" lines. Absence is fine: the ⌥Space fallback covers v0.1.
	const binary = fnHelperPath()
	try {
		if (!fs.existsSync(binary)) {
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
		detail: '⌥Space starts/stops as a fallback.\nEsc cancels while listening.\nListening stops automatically at the time limit.\nHover the pill to expand it — hold to talk, or double-click to keep recording until you click again.\nIn a video call the pill offers Transcribe meeting — click to record, click again to stop; the transcript and summary land in History.\nChange provider, model, or language anytime via Setup & permissions…',
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
		height: 800,
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
	// Place before the first show so the pill never flashes at a stale spot.
	await updatePillPlacement()
	screen.on('display-metrics-changed', followDock)
	setInterval(followDock, 1500)
	setInterval(pollMeetingSuggest, MEETING_POLL_MS)
	void pollMeetingSuggest()
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

	try {
		historyDb = openHistoryDb(getHistoryDbPath())
	} catch (error) {
		console.log(`[flow] history db unavailable: ${error instanceof Error ? error.message : error}`)
	}

	tray = new Tray(nativeImage.createEmpty())
	tray.setTitle('◉')
	tray.setToolTip('Flow — hold fn to dictate')
	tray.setContextMenu(buildTrayMenu())

	ipcMain.on('flow:audio', (_e, payload: { base64: string; mime: string; done: boolean }) => {
		if (meetingRecording) {
			audioMime = payload.mime || audioMime
			if (payload.base64) meetingChunks.push(Buffer.from(payload.base64, 'base64'))
			return
		}
		if (!recording && !payload.done) return
		audioMime = payload.mime || audioMime
		if (payload.base64) chunks.push(Buffer.from(payload.base64, 'base64'))
	})
	ipcMain.on('flow:start-ui', () => void startListening('mouse'))
	ipcMain.on('flow:stop-ui', () => void stopListening('ui'))
	ipcMain.on('meeting:start-ui', () => void startMeeting())
	ipcMain.on('meeting:stop-ui', () => void stopMeeting('ui'))
	ipcMain.on('flow:hover', (_e, hovering: unknown) => {
		if (hovering === true) capturePasteTarget()
		applyPillInteractive(hovering === true)
	})
	ipcMain.on('flow:cancel', () => cancelListening())
	ipcMain.handle('history:list', (_e, opts: unknown) => (historyDb ? listTranscriptions(historyDb, (opts ?? {}) as HistoryListOptions) : { rows: [], total: 0 }))
	ipcMain.handle('history:clear', () => (historyDb ? clearHistory(historyDb) : 0))
	ipcMain.on('history:copy', (_e, text: unknown) => {
		if (typeof text === 'string' && text) clipboard.writeText(text)
	})
	ipcMain.handle('onboarding:get', async () => {
		const permissions = await report()
		// Helper spawned before the grant exits denied and is never retried; a
		// fresh spawn picks up trust as soon as the system records it.
		if (permissions.accessibility === 'granted' && !fnHelper) spawnFnHelper()
		return {
			permissions,
			setup: providerStatus(),
			providers: Object.entries(PROVIDERS).map(([id, definition]) => ({ id, ...definition })),
			configuredProviders: STT_PROVIDERS.filter((id) => Boolean(loadProviderToken(id))),
			llm: llmStatus(),
		}
	})
	ipcMain.handle('onboarding:save-setup', (_event, setup) => saveProviderSetup(setup))
	ipcMain.handle('onboarding:save-llm', (_event, setup) => saveLlmSetup(setup))
	ipcMain.handle('onboarding:test-stt', async (_event, setup) => {
		const resolved = resolveProviderSetup(setup)
		await testSttProvider(createSttProvider(resolved.settings, resolved.token), resolved.settings.language || undefined)
		return { provider: resolved.settings.provider, model: resolved.settings.model }
	})
	ipcMain.handle('onboarding:test-llm', async (_event, setup) => {
		const resolved = resolveLlmSetup(setup)
		const client = createLlmClient(resolved.settings, resolved.token)
		if (!client) throw new Error('An LLM API key is required.')
		await client.summarize('Reply with exactly: OK.')
		return { model: resolved.settings.llmModel }
	})
	ipcMain.handle('permissions:request-mic', async () => {
		const granted = await requestMicrophone()
		console.log(`[flow] microphone request → ${granted ? 'granted' : 'denied'}`)
		return granted
	})
	ipcMain.handle('permissions:prompt-accessibility', () => promptAccessibility())
	ipcMain.handle('app:restart', () => {
		// Input Monitoring and Accessibility trust are evaluated at launch; a
		// toggle in System Settings only reaches a relaunched instance.
		app.relaunch()
		app.exit(0)
	})
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
	try {
		historyDb?.close()
	} catch {
		// ignore
	}
})
