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
} as const

contextBridge.exposeInMainWorld('flow', {
	onState: (cb: (state: FlowState) => void) => {
		ipcRenderer.on(IPC_CHANNELS.FLOW_STATE, (_: unknown, state: FlowState) => cb(state))
	},
	onCommand: (cmd: 'start' | 'stop' | 'cancel', cb: () => void) => {
		const channel = cmd === 'start' ? IPC_CHANNELS.FLOW_START : cmd === 'stop' ? IPC_CHANNELS.FLOW_STOP : IPC_CHANNELS.FLOW_CANCEL
		ipcRenderer.on(channel, () => cb())
	},
	start: () => ipcRenderer.send('flow:start-ui'),
	audioChunk: (base64: string, mime: string, done: boolean) => ipcRenderer.send('flow:audio', { base64, mime, done }),
	cancel: () => ipcRenderer.send('flow:cancel'),
})

contextBridge.exposeInMainWorld('flowSetup', {
	get: () => ipcRenderer.invoke('onboarding:get'),
	save: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => ipcRenderer.invoke('onboarding:save-setup', setup),
	requestMic: () => ipcRenderer.invoke('permissions:request-mic'),
	promptAccessibility: () => ipcRenderer.invoke('permissions:prompt-accessibility'),
	openInputMonitoring: () => ipcRenderer.invoke('permissions:open-input-monitoring'),
	restart: () => ipcRenderer.invoke('app:restart'),
	complete: () => ipcRenderer.invoke('onboarding:complete'),
})
