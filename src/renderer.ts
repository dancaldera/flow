
declare global {
	interface Window {
		flow: {
			onState: (cb: (s: { phase: string; message?: string; seconds?: number }) => void) => void
			onCommand: (cmd: 'start' | 'stop' | 'cancel', cb: () => void) => void
			audioChunk: (base64: string, mime: string, done: boolean) => void
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

function setUI(phase: string, message?: string, seconds?: number): void {
	document.body.dataset.phase = phase
	if (phase === 'listening') {
		dot.className = 'dot live'
		hint.textContent = seconds ? `Listening… ${seconds}s` : 'Listening…'
	} else if (phase === 'working') {
		dot.className = 'dot busy'
		hint.textContent = 'Transcribing…'
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
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } })
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

window.flow.onState((s) => setUI(s.phase, s.message, s.seconds))
window.flow.onCommand('start', () => void startCapture())
window.flow.onCommand('stop', () => void stopCapture(true))
window.flow.onCommand('cancel', () => void stopCapture(false))
setUI('idle')
