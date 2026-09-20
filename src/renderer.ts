
declare global {
	interface Window {
		flow: {
			onState: (cb: (s: { phase: string; message?: string; seconds?: number }) => void) => void
			onCommand: (cmd: 'start' | 'stop' | 'cancel', cb: () => void) => void
			onMeetingSuggest: (cb: (suggest: boolean) => void) => void
			onMeetingActive: (cb: (active: boolean) => void) => void
			audioChunk: (base64: string, mime: string, done: boolean) => void
			start: () => void
			stop: () => void
			startMeeting: () => void
			stopMeeting: () => void
			setHover: (hovering: boolean) => void
		}
	}
}

// Must match ERROR_VISIBLE_MS in src/ipc.ts (renderer loads as a plain
// <script>, so it cannot import the shared module).
const ERROR_VISIBLE_MS = 4000
const dot = document.getElementById('dot') as HTMLSpanElement
const hint = document.getElementById('hint') as HTMLDivElement

let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let mime = 'audio/webm'
// A stop that lands while getUserMedia is still pending must release the mic
// once it resolves, or the recorder outlives the session and macOS keeps the
// mic indicator on.
let captureGeneration = 0

function setUI(phase: string, message?: string, seconds?: number): void {
	document.body.dataset.phase = phase
	if (phase === 'listening') {
		dot.className = 'dot live'
		const base = message ?? 'Listening…'
		hint.textContent = seconds ? `${base} ${seconds}s` : base
	} else if (phase === 'working') {
		dot.className = 'dot busy'
		hint.textContent = message ?? 'Transcribing…'
	} else if (phase === 'error') {
		dot.className = 'dot err'
		hint.textContent = message ?? 'Something went wrong'
	} else {
		dot.className = 'dot idle'
		hint.textContent = ''
	}
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			const result = String(reader.result ?? '')
			resolve(result.includes(',') ? result.split(',')[1]! : result)
		}
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}

async function startCapture(): Promise<void> {
	const generation = ++captureGeneration
	try {
		if (stream) {
			stream.getTracks().forEach((t) => t.stop())
			stream = null
		}
		const devices = await navigator.mediaDevices.enumerateDevices()
		const defaultOutputGroup = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default')?.groupId
		const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default')
		// Opening a Bluetooth headset mic forces its playback into low-quality
		// hands-free mode. Prefer the Mac mic, otherwise any mic outside the
		// current output device.
		const input =
			inputs.find((device) => /MacBook|iMac|Studio Display|built-in|internal/i.test(device.label)) ??
			(defaultOutputGroup ? inputs.find((device) => device.groupId !== defaultOutputGroup) : undefined)
		const media = await navigator.mediaDevices.getUserMedia({
			audio: {
				...(input ? { deviceId: { exact: input.deviceId } } : {}),
				channelCount: 1,
				sampleRate: 16000,
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
		})
		if (generation !== captureGeneration) {
			media.getTracks().forEach((t) => t.stop())
			return
		}
		stream = media
		mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
		recorder = new MediaRecorder(stream, { mimeType: mime })
		recorder.ondataavailable = (event: BlobEvent) => {
			if (!event.data.size) return
			void blobToBase64(event.data).then((base64) => window.flow.audioChunk(base64, mime, false))
		}
		recorder.start(250)
	} catch {
		setUI('error', 'Mic blocked — allow Microphone access')
		setTimeout(() => setUI('idle'), ERROR_VISIBLE_MS)
	}
}

async function stopCapture(sendDone: boolean): Promise<void> {
	captureGeneration++
	const rec = recorder
	recorder = null
	if (rec && rec.state !== 'inactive') {
		await new Promise<void>((resolve) => {
			rec.onstop = () => resolve()
			rec.stop()
		})
	}
	stream?.getTracks().forEach((t) => t.stop())
	stream = null
	if (sendDone) window.flow.audioChunk('', mime, true)
}

let phase = 'idle'
let hovering = false
let mouseDown = false
let mouseRecording = false
let meetingSuggest = false
let meetingActive = false
let lastHoverSent: boolean | null = null

// A press shorter than this is a tap (double-click candidate); a longer
// press is a hold that stops the moment it is released.
const HOLD_TO_TALK_MS = 250
// Window after a tap's release in which a second press latches instead.
const DOUBLE_TAP_WINDOW_MS = 400

let downTime = 0
let latched = false
let pendingTap = false
let pendingTapTimer: ReturnType<typeof setTimeout> | null = null

function clearLocalRecording(): void {
	mouseDown = false
	mouseRecording = false
	latched = false
	pendingTap = false
	if (pendingTapTimer) {
		clearTimeout(pendingTapTimer)
		pendingTapTimer = null
	}
}

// Interactive while the cursor is over the idle pill (expanded), while a
// mouse-initiated recording is in flight (so the release always lands), or
// for the whole meeting (so the stop press always lands). Hover visuals are
// additionally scoped to idle in CSS, so recording via fn keeps its own UI
// even with the cursor parked over the pill.
function updateHover(): void {
	const active = meetingActive || mouseDown || mouseRecording || (hovering && phase === 'idle')
	document.body.dataset.hover = active ? 'true' : 'false'
	if (active !== lastHoverSent) {
		lastHoverSent = active
		window.flow.setHover(active)
	}
}

// The meeting teaser shows on the idle pill only; anywhere else the meeting
// flag is stale UI waiting for the next idle.
function applyMeeting(): void {
	document.body.dataset.meeting = meetingSuggest && phase === 'idle' ? 'true' : 'false'
}

const pill = document.getElementById('pill') as HTMLDivElement
const meet = document.getElementById('meet') as HTMLSpanElement
// The teaser starts a meeting instead of a snippet: stop propagation so the
// pill's hold-to-talk press below never fires for the same click.
meet.addEventListener('mousedown', (event) => {
	event.stopPropagation()
	if (!meetingSuggest || phase !== 'idle' || mouseDown || mouseRecording) return
	window.flow.startMeeting()
})
pill.addEventListener('mouseenter', () => {
	hovering = true
	updateHover()
})
pill.addEventListener('mouseleave', () => {
	hovering = false
	updateHover()
})
// Press-and-hold mirrors the fn key: release over the pill stops. A release
// outside the window never arrives — Esc, the time limit, or the next state
// change still ends the recording, and the flags below are cleared so the
// pill cannot stick interactive. Two quick taps latch instead: recording
// continues hands-free until the next press.
pill.addEventListener('mousedown', () => {
	if (meetingActive) {
		// The whole pill is the stop button during a meeting.
		window.flow.stopMeeting()
		return
	}
	if (latched) {
		// Single press stops a latched recording.
		latched = false
		window.flow.stop()
		updateHover()
		return
	}
	if (pendingTap && mouseRecording) {
		// Second tap in time: latch — the recording continues seamlessly.
		pendingTap = false
		if (pendingTapTimer) {
			clearTimeout(pendingTapTimer)
			pendingTapTimer = null
		}
		latched = true
		mouseDown = true
		updateHover()
		return
	}
	if (phase !== 'idle' || mouseDown) return
	mouseDown = true
	mouseRecording = true
	downTime = Date.now()
	window.flow.start()
	updateHover()
})
window.addEventListener('mouseup', () => {
	if (!mouseDown) return
	mouseDown = false
	if (latched) {
		// Release of the latching press: keep recording.
		updateHover()
		return
	}
	if (phase === 'idle') {
		// Main never confirmed the start (e.g. it was guarded during an
		// update check): nothing is recording, just reset local state. A
		// confirmed start always flips the phase within milliseconds, far
		// sooner than any release this handler can observe.
		clearLocalRecording()
		updateHover()
		return
	}
	if (Date.now() - downTime >= HOLD_TO_TALK_MS) {
		window.flow.stop()
	} else {
		// Tap: keep recording briefly to catch a second tap for latching.
		pendingTap = true
		if (pendingTapTimer) clearTimeout(pendingTapTimer)
		pendingTapTimer = setTimeout(() => {
			pendingTapTimer = null
			pendingTap = false
			window.flow.stop()
			updateHover()
		}, DOUBLE_TAP_WINDOW_MS)
	}
	updateHover()
})

window.flow.onState((s) => {
	phase = s.phase
	if (s.phase !== 'listening') clearLocalRecording()
	setUI(s.phase, s.message, s.seconds)
	if (s.phase === 'listening' && (latched || meetingActive)) hint.textContent += ' · click to stop'
	applyMeeting()
	updateHover()
})
window.flow.onCommand('start', () => void startCapture())
window.flow.onCommand('stop', () => void stopCapture(true))
window.flow.onCommand('cancel', () => void stopCapture(false))
window.flow.onMeetingSuggest((suggest) => {
	meetingSuggest = suggest
	applyMeeting()
})
window.flow.onMeetingActive((active) => {
	meetingActive = active
	updateHover()
})
setUI('idle')
applyMeeting()
updateHover()
