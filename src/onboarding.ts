export {}

type PermissionState = 'granted' | 'missing' | 'unknown'
type ProviderModel = { id: string; label: string; blurb: string; languages: string[] }
type Provider = { id: string; label: string; defaultModel: string; models: ProviderModel[]; needsAccountId: boolean; needsGatewayId: boolean }
type Setup = { provider: string; model: string; language: string; configured: boolean }
type OnboardingState = { permissions: { microphone: PermissionState; accessibility: PermissionState; axHint?: string }; setup: Setup; providers: Provider[]; configuredProviders: string[] }

const DEFAULT_AX_HINT = 'Lets Flow hear the <b>fn</b> key anywhere and paste text at your cursor. Click, then toggle Flow on in Settings.'

declare global {
	interface Window {
		flowSetup: {
			get: () => Promise<OnboardingState>
			save: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => Promise<Setup>
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
const modelSearch = document.getElementById('model-search') as HTMLInputElement
const modelSelect = document.getElementById('model') as HTMLSelectElement
const modelHint = document.getElementById('model-hint') as HTMLDivElement
const langSearch = document.getElementById('language-search') as HTMLInputElement
const langSelect = document.getElementById('language') as HTMLSelectElement
const langHint = document.getElementById('language-hint') as HTMLDivElement
const cloudflareFields = document.getElementById('cloudflare-fields') as HTMLDivElement
const accountId = document.getElementById('account-id') as HTMLInputElement
const gatewayId = document.getElementById('gateway-id') as HTMLInputElement
const token = document.getElementById('token') as HTMLInputElement
const keyStatus = document.getElementById('key-status') as HTMLDivElement
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
let modelsFor = ''
let langsFor = ''

function selectedProvider(): Provider | undefined {
	return state?.providers.find((provider) => provider.id === providerId)
}

function providerModels(provider: Provider): ProviderModel[] {
	return provider.models?.length ? provider.models : [{ id: provider.defaultModel, label: provider.defaultModel, blurb: '', languages: [] }]
}

function selectProvider(id: string, keepModel?: string, keepLang?: string): void {
	providerId = id
	providerSelect.value = id
	modelSearch.value = ''
	langSearch.value = ''
	token.value = ''
	buildModelOptions(keepModel, keepLang)
	renderProvider()
}

function renderKeyStatus(): void {
	const provider = selectedProvider()
	if (!provider) {
		keyStatus.textContent = ''
		return
	}
	const saved = (state?.configuredProviders ?? []).includes(provider.id)
	keyStatus.classList.toggle('saved', saved)
	if (saved) {
		keyStatus.textContent = `✓ API key saved for ${provider.label}. Leave empty to keep it — a new key replaces it.`
		token.placeholder = 'Saved •••••• — enter a new key to replace'
	} else {
		keyStatus.textContent = `No API key saved for ${provider.label} yet.`
		token.placeholder = ''
	}
}

function selectedModel(): ProviderModel | undefined {
	const provider = selectedProvider()
	return provider && providerModels(provider).find((option) => option.id === modelSelect.value)
}

const EXTRA_LANGUAGE_LABELS: Record<string, string> = { multi: 'Multilingual (auto code-switching)' }

let languageNames: Intl.DisplayNames | null = null

function languageName(code: string): string {
	const extra = EXTRA_LANGUAGE_LABELS[code]
	if (extra) return extra
	try {
		languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' })
		return languageNames.of(code.replace(/_/g, '-')) ?? code
	} catch {
		return code
	}
}

function buildModelOptions(keepModel?: string, keepLang?: string): void {
	const provider = selectedProvider()
	if (!provider) return
	const models = providerModels(provider)
	const wanted = keepModel && models.some((option) => option.id === keepModel) ? keepModel : provider.defaultModel
	modelSelect.replaceChildren()
	for (const option of models) {
		const element = document.createElement('option')
		element.value = option.id
		element.textContent = `${option.label} — ${option.id}`
		modelSelect.append(element)
	}
	modelSelect.value = wanted
	modelsFor = provider.id
	filterModels()
	buildLanguageOptions(keepLang)
}

function buildLanguageOptions(keepLang?: string): void {
	const codes = selectedModel()?.languages ?? []
	const wanted = keepLang && codes.includes(keepLang) ? keepLang : ''
	langSelect.replaceChildren()
	const auto = document.createElement('option')
	auto.value = ''
	auto.textContent = 'Auto-detect (recommended)'
	langSelect.append(auto)
	for (const code of codes) {
		const element = document.createElement('option')
		element.value = code
		element.textContent = `${languageName(code)} — ${code}`
		langSelect.append(element)
	}
	langSelect.value = wanted
	langsFor = `${providerId}|${modelSelect.value}`
	filterLanguages()
}

function renderLanguageHint(): void {
	if (!langSelect.value) {
		langHint.textContent = (selectedModel()?.languages.length ?? 0) > 0 ? 'Auto-detect: the provider identifies the language.' : 'This provider auto-detects the language.'
	} else {
		langHint.textContent = `Sends language=${langSelect.value} to ${selectedProvider()?.label ?? 'provider'}.`
	}
}

function filterLanguages(): void {
	const query = langSearch.value.trim().toLowerCase()
	for (const option of Array.from(langSelect.options)) {
		option.hidden = Boolean(query) && !option.textContent?.toLowerCase().includes(query)
	}
	const selected = langSelect.selectedOptions[0]
	if (selected?.hidden) {
		const firstVisible = Array.from(langSelect.options).find((option) => !option.hidden)
		if (firstVisible) langSelect.value = firstVisible.value
	}
	renderLanguageHint()
}

function renderModelHint(): void {
	const provider = selectedProvider()
	const option = provider && providerModels(provider).find((candidate) => candidate.id === modelSelect.value)
	modelHint.textContent = option ? [option.id, option.blurb].filter(Boolean).join(' — ') : modelSelect.value
}

function filterModels(): void {
	const query = modelSearch.value.trim().toLowerCase()
	for (const option of Array.from(modelSelect.options)) {
		option.hidden = Boolean(query) && !option.textContent?.toLowerCase().includes(query)
	}
	const selected = modelSelect.selectedOptions[0]
	if (selected?.hidden) {
		const firstVisible = Array.from(modelSelect.options).find((option) => !option.hidden)
		if (firstVisible) modelSelect.value = firstVisible.value
	}
	renderModelHint()
}

function renderProvider(): void {
	const provider = selectedProvider()
	if (!provider) return
	if (modelsFor !== provider.id) buildModelOptions(modelSelect.value || undefined, langSelect.value || undefined)
	else renderModelHint()
	if (langsFor !== `${providerId}|${modelSelect.value}`) buildLanguageOptions(langSelect.value || undefined)
	else renderLanguageHint()
	renderKeyStatus()
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
	}
	if (!providerId || !state.providers.some((provider) => provider.id === providerId)) {
		const initial = state.providers.some((provider) => provider.id === state?.setup.provider) ? state.setup.provider : state.providers[0].id
		const keepSaved = initial === state.setup.provider
		selectProvider(initial, keepSaved ? state.setup.model : undefined, keepSaved ? state.setup.language : undefined)
	} else {
		renderProvider()
	}
	dotMic.className = `dot ${state.permissions.microphone}`
	dotAx.className = `dot ${state.permissions.accessibility}`
	btnMic.disabled = state.permissions.microphone === 'granted'
	btnMic.textContent = btnMic.disabled ? 'Enabled ✓' : 'Enable Microphone'
	axHint.innerHTML = state.permissions.axHint ?? DEFAULT_AX_HINT
	btnAx.textContent = state.permissions.accessibility === 'granted' ? 'Granted ✓ — re-open Settings' : 'Open Accessibility Settings'
	btnDone.disabled = !state.setup.configured || state.permissions.microphone !== 'granted' || state.permissions.accessibility !== 'granted'
}

providerSelect.onchange = () => {
	const keepSaved = providerSelect.value === state?.setup.provider
	selectProvider(providerSelect.value, keepSaved ? state?.setup.model : undefined, keepSaved ? state?.setup.language : undefined)
}
modelSearch.oninput = () => filterModels()
modelSelect.onchange = () => {
	renderModelHint()
	buildLanguageOptions(langSelect.value || undefined)
}
langSearch.oninput = () => filterLanguages()
langSelect.onchange = () => renderLanguageHint()
btnSave.onclick = () =>
	void (async () => {
		error.textContent = ''
		btnSave.disabled = true
		try {
			await window.flowSetup.save({ provider: providerId, accountId: accountId.value, gatewayId: gatewayId.value, model: modelSelect.value, language: langSelect.value, token: token.value })
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
