export {}

type PermissionState = 'granted' | 'missing' | 'unknown'
type Provider = { id: string; label: string; defaultModel: string; needsAccountId: boolean; needsGatewayId: boolean }
type Setup = { provider: string; model: string; configured: boolean }
type OnboardingState = { permissions: { microphone: PermissionState; accessibility: PermissionState; axHint?: string }; setup: Setup; providers: Provider[] }

const DEFAULT_AX_HINT = 'Lets Flow hear the <b>fn</b> key anywhere and paste text at your cursor. Click, then toggle Flow on in Settings.'

declare global {
	interface Window {
		flowSetup: {
			get: () => Promise<OnboardingState>
			save: (setup: { provider: string; accountId: string; gatewayId: string; token: string }) => Promise<Setup>
			requestMic: () => Promise<boolean>
			promptAccessibility: () => Promise<void>
			openInputMonitoring: () => Promise<void>
			complete: () => Promise<boolean>
		}
	}
}

const setupStep = document.getElementById('setup-step') as HTMLElement
const permissionsStep = document.getElementById('permissions-step') as HTMLElement
const providerSelect = document.getElementById('provider') as HTMLSelectElement
const model = document.getElementById('model') as HTMLDivElement
const cloudflareFields = document.getElementById('cloudflare-fields') as HTMLDivElement
const accountId = document.getElementById('account-id') as HTMLInputElement
const gatewayId = document.getElementById('gateway-id') as HTMLInputElement
const token = document.getElementById('token') as HTMLInputElement
const error = document.getElementById('error') as HTMLDivElement
const dotMic = document.getElementById('dot-mic') as HTMLSpanElement
const dotAx = document.getElementById('dot-ax') as HTMLSpanElement
const axHint = document.getElementById('ax-hint') as HTMLParagraphElement
const btnMic = document.getElementById('btn-mic') as HTMLButtonElement
const btnAx = document.getElementById('btn-ax') as HTMLButtonElement
const btnIm = document.getElementById('btn-im') as HTMLButtonElement
const btnSave = document.getElementById('btn-save') as HTMLButtonElement
const btnDone = document.getElementById('btn-done') as HTMLButtonElement
const btnChange = document.getElementById('btn-change') as HTMLButtonElement

let state: OnboardingState | null = null
let providerId = ''

function selectedProvider(): Provider | undefined {
	return state?.providers.find((provider) => provider.id === providerId)
}

function selectProvider(id: string): void {
	providerId = id
	providerSelect.value = id
	renderProvider()
}

function renderProvider(): void {
	const provider = selectedProvider()
	if (!provider) return
	model.textContent = provider.defaultModel
	cloudflareFields.classList.toggle('hidden', !provider.needsAccountId)
}

function showPermissions(): void {
	setupStep.classList.add('hidden')
	permissionsStep.classList.remove('hidden')
}

function showSetup(): void {
	permissionsStep.classList.add('hidden')
	setupStep.classList.remove('hidden')
}

async function refresh(): Promise<void> {
	try {
		if (!window.flowSetup) {
			error.textContent = 'Setup must be opened from the Flow app (tray menu → Setup & permissions…).'
			return
		}
		state = await window.flowSetup.get()
	} catch (cause) {
		error.textContent = cause instanceof Error ? cause.message : 'Could not load setup.'
		return
	}
	if (!state.providers.length) {
		error.textContent = 'No transcription providers available.'
		return
	}
	if (!providerSelect.options.length) {
		for (const provider of state.providers) {
			const option = document.createElement('option')
			option.value = provider.id
			option.textContent = provider.label
			providerSelect.append(option)
		}
		selectProvider(state.providers.some((provider) => provider.id === state?.setup.provider) ? state.setup.provider : state.providers[0].id)
	}
	dotMic.className = `dot ${state.permissions.microphone}`
	dotAx.className = `dot ${state.permissions.accessibility}`
	btnMic.disabled = state.permissions.microphone === 'granted'
	btnMic.textContent = btnMic.disabled ? 'Enabled ✓' : 'Enable Microphone'
	axHint.innerHTML = state.permissions.axHint ?? DEFAULT_AX_HINT
	btnAx.textContent = state.permissions.accessibility === 'granted' ? 'Granted ✓ — re-open Settings' : 'Open Accessibility Settings'
	btnDone.disabled = !state.setup.configured || state.permissions.microphone !== 'granted' || state.permissions.accessibility !== 'granted'
}

providerSelect.onchange = () => selectProvider(providerSelect.value)
btnSave.onclick = () =>
	void (async () => {
		error.textContent = ''
		btnSave.disabled = true
		try {
			await window.flowSetup.save({ provider: providerId, accountId: accountId.value, gatewayId: gatewayId.value, token: token.value })
			token.value = ''
			await refresh()
			showPermissions()
		} catch (cause) {
			error.textContent = cause instanceof Error ? cause.message : 'Could not save setup.'
		} finally {
			btnSave.disabled = false
		}
	})()
btnMic.onclick = () => void window.flowSetup.requestMic().then(refresh)
btnAx.onclick = () => void window.flowSetup.promptAccessibility().then(refresh)
btnIm.onclick = () => void window.flowSetup.openInputMonitoring()
btnChange.onclick = showSetup
btnDone.onclick = () => void window.flowSetup.complete().then((started) => started && window.close())

void refresh().then(() => (state?.setup.configured ? showPermissions() : showSetup()))
setInterval(() => void refresh(), 1500)
