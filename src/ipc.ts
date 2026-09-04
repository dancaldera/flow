export const IPC_CHANNELS = {
	FLOW_STATE: 'flow:state',
	FLOW_START: 'flow:start',
	FLOW_STOP: 'flow:stop',
	FLOW_CANCEL: 'flow:cancel',
	FLOW_TRANSCRIPT: 'flow:transcript',
} as const

export type FlowPhase = 'idle' | 'listening' | 'working' | 'error'

export interface FlowState {
	phase: FlowPhase
	message?: string
	seconds?: number
}
