import { contextBridge, ipcRenderer } from 'electron'
import type { FlowState } from './ipc'

// Channel names are inlined instead of importing ./ipc: preload scripts run
// sandboxed, where relative require() calls fail to resolve and the whole
// bridge silently never loads. Keep in sync with src/ipc.ts.
const IPC_CHANNELS = {
	FLOW_STATE: 'flow:state',
	FLOW_START: 'flow:start',
	FLOW_STOP: 'flow:stop',
	FLOW_CANCEL: 'flow:cancel',
	FLOW_TRANSCRIPT: 'flow:transcript',
	MEETING_SUGGEST: 'meeting:suggest',
	MEETING_ACTIVE: 'meeting:active',
} as const

contextBridge.exposeInMainWorld('flow', {
	onState: (cb: (state: FlowState) => void) => {
		ipcRenderer.on(IPC_CHANNELS.FLOW_STATE, (_: unknown, state: FlowState) => cb(state))
	},
	onCommand: (cmd: 'start' | 'stop' | 'cancel', cb: () => void) => {
		const channel = cmd === 'start' ? IPC_CHANNELS.FLOW_START : cmd === 'stop' ? IPC_CHANNELS.FLOW_STOP : IPC_CHANNELS.FLOW_CANCEL
		ipcRenderer.on(channel, () => cb())
	},
	onMeetingSuggest: (cb: (suggest: boolean) => void) => {
		ipcRenderer.on(IPC_CHANNELS.MEETING_SUGGEST, (_: unknown, suggest: boolean) => cb(suggest))
	},
	onMeetingActive: (cb: (active: boolean) => void) => {
		ipcRenderer.on(IPC_CHANNELS.MEETING_ACTIVE, (_: unknown, active: boolean) => cb(active))
	},
	start: () => ipcRenderer.send('flow:start-ui'),
	stop: () => ipcRenderer.send('flow:stop-ui'),
	startMeeting: () => ipcRenderer.send('meeting:start-ui'),
	stopMeeting: () => ipcRenderer.send('meeting:stop-ui'),
	setHover: (hovering: boolean) => ipcRenderer.send('flow:hover', hovering),
	audioChunk: (base64: string, mime: string, done: boolean) => ipcRenderer.send('flow:audio', { base64, mime, done }),
	cancel: () => ipcRenderer.send('flow:cancel'),
})

contextBridge.exposeInMainWorld('flowHistory', {
	list: (opts?: { limit?: number; offset?: number; query?: string }) => ipcRenderer.invoke('history:list', opts ?? {}),
	clear: () => ipcRenderer.invoke('history:clear'),
	copy: (text: string) => ipcRenderer.send('history:copy', text),
})

contextBridge.exposeInMainWorld('flowSetup', {
	get: () => ipcRenderer.invoke('onboarding:get'),
	save: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => ipcRenderer.invoke('onboarding:save-setup', setup),
	saveLlm: (setup: { baseUrl: string; model: string; token: string }) => ipcRenderer.invoke('onboarding:save-llm', setup),
	testStt: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => ipcRenderer.invoke('onboarding:test-stt', setup),
	testLlm: (setup: { baseUrl: string; model: string; token: string }) => ipcRenderer.invoke('onboarding:test-llm', setup),
	requestMic: () => ipcRenderer.invoke('permissions:request-mic'),
	promptAccessibility: () => ipcRenderer.invoke('permissions:prompt-accessibility'),
	openInputMonitoring: () => ipcRenderer.invoke('permissions:open-input-monitoring'),
	restart: () => ipcRenderer.invoke('app:restart'),
	complete: () => ipcRenderer.invoke('onboarding:complete'),
})
