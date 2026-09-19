export {}

type PermissionState = 'granted' | 'missing' | 'unknown'
type ProviderModel = { id: string; label: string; blurb: string; languages: string[] }
type Provider = { id: string; label: string; defaultModel: string; models: ProviderModel[]; needsAccountId: boolean; needsGatewayId: boolean }
type Setup = { provider: string; model: string; language: string; configured: boolean }
type LlmState = { baseUrl: string; model: string; configured: boolean }
type JevState = { configured: boolean; provider: 'openrouter' | 'typesafe' | null }
type OnboardingState = { permissions: { microphone: PermissionState; accessibility: PermissionState; inputMonitoring?: PermissionState; axHint?: string }; setup: Setup; providers: Provider[]; configuredProviders: string[]; llm: LlmState; jev: JevState }

const DEFAULT_AX_HINT = 'Lets Flow hear the <b>fn</b> key anywhere and paste text at your cursor. Click, then toggle Flow on in Settings.'

declare global {
	interface Window {
		flowSetup: {
			get: () => Promise<OnboardingState>
			save: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => Promise<Setup>
			saveLlm: (setup: { baseUrl: string; model: string; token: string }) => Promise<LlmState>
			testStt: (setup: { provider: string; accountId: string; gatewayId: string; model: string; language: string; token: string }) => Promise<{ provider: string; model: string }>
			testLlm: (setup: { baseUrl: string; model: string; token: string }) => Promise<{ model: string }>
			saveJev: (setup: { token: string }) => Promise<JevState>
			testJev: (setup: { token: string }) => Promise<{ provider: 'openrouter' | 'typesafe' }>
			requestMic: () => Promise<boolean>
			promptAccessibility: () => Promise<void>
			openInputMonitoring: () => Promise<void>
			restart: () => Promise<void>
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
const btnTestStt = document.getElementById('btn-test-stt') as HTMLButtonElement
const sttTestStatus = document.getElementById('stt-test-status') as HTMLSpanElement
const llmBaseUrl = document.getElementById('llm-base-url') as HTMLInputElement
const llmModel = document.getElementById('llm-model') as HTMLInputElement
const llmToken = document.getElementById('llm-token') as HTMLInputElement
const llmStatus = document.getElementById('llm-status') as HTMLDivElement
const btnTestLlm = document.getElementById('btn-test-llm') as HTMLButtonElement
const llmTestStatus = document.getElementById('llm-test-status') as HTMLSpanElement
const jevToken = document.getElementById('jev-token') as HTMLInputElement
const jevStatus = document.getElementById('jev-status') as HTMLDivElement
const btnTestJev = document.getElementById('btn-test-jev') as HTMLButtonElement
const jevTestStatus = document.getElementById('jev-test-status') as HTMLSpanElement
const error = document.getElementById('error') as HTMLDivElement
const dotMic = document.getElementById('dot-mic') as HTMLSpanElement
const btnMic = document.getElementById('btn-mic') as HTMLButtonElement
const dotAx = document.getElementById('dot-ax') as HTMLSpanElement
const dotIm = document.getElementById('dot-im') as HTMLSpanElement
const axHint = document.getElementById('ax-hint') as HTMLParagraphElement
const btnAx = document.getElementById('btn-ax') as HTMLButtonElement
const btnIm = document.getElementById('btn-im') as HTMLButtonElement
const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement
const btnSave = document.getElementById('btn-save') as HTMLButtonElement
const btnDone = document.getElementById('btn-done') as HTMLButtonElement
const btnChange = document.getElementById('btn-change') as HTMLButtonElement

let state: OnboardingState | null = null
let providerId = ''
let modelsFor = ''
let langsFor = ''
let llmInit = false

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

function renderLlm(): void {
	if (!state) return
	// Fill the endpoint/model once: refresh() re-runs every 1.5s and must not
	// clobber what the user is typing. The key field stays write-only.
	if (!llmInit) {
		llmInit = true
		llmBaseUrl.value = state.llm.baseUrl
		llmModel.value = state.llm.model
	}
	llmStatus.classList.toggle('saved', state.llm.configured)
	if (state.llm.configured) {
		llmStatus.textContent = `✓ LLM key saved (${state.llm.model}). Leave empty to keep it — a new key replaces it.`
		llmToken.placeholder = 'Saved •••••• — enter a new key to replace'
	} else {
		llmStatus.textContent = 'Optional: no LLM key saved, meetings keep transcripts without summaries.'
		llmToken.placeholder = ''
	}
}

function renderJev(): void {
	if (!state) return
	jevStatus.classList.toggle('saved', state.jev.configured)
	if (state.jev.configured) {
		jevStatus.textContent = `✓ Jev key saved (${state.jev.provider}). Leave empty to keep it — a new key replaces it.`
		jevToken.placeholder = 'Saved •••••• — enter a new key to replace'
	} else {
		jevStatus.textContent = 'Optional: no Jev key saved — say "mute", "undo", "open terminal" once you add one (sk-or-… keys go via OpenRouter).'
		jevToken.placeholder = ''
	}
}

function testStatus(element: HTMLSpanElement, message: string, kind = ''): void {
	element.textContent = message
	element.className = `test-status ${kind}`.trim()
}

function clearSttTest(): void {
	testStatus(sttTestStatus, '')
}

function clearLlmTest(): void {
	testStatus(llmTestStatus, '')
}

function clearJevTest(): void {
	testStatus(jevTestStatus, '')
}

async function testStt(): Promise<void> {
	btnTestStt.disabled = true
	testStatus(sttTestStatus, 'Testing…')
	try {
		const result = await window.flowSetup.testStt({
			provider: providerId,
			accountId: accountId.value,
			gatewayId: gatewayId.value,
			model: modelSelect.value,
			language: langSelect.value,
			token: token.value,
		})
		testStatus(sttTestStatus, `✓ ${result.model} accepted.`, 'ok')
	} catch (cause) {
		testStatus(sttTestStatus, cause instanceof Error ? cause.message : 'Could not test transcription.', 'fail')
	} finally {
		btnTestStt.disabled = false
	}
}

async function testLlm(): Promise<void> {
	btnTestLlm.disabled = true
	testStatus(llmTestStatus, 'Testing…')
	try {
		const result = await window.flowSetup.testLlm({ baseUrl: llmBaseUrl.value, model: llmModel.value, token: llmToken.value })
		testStatus(llmTestStatus, `✓ ${result.model} responded.`, 'ok')
	} catch (cause) {
		testStatus(llmTestStatus, cause instanceof Error ? cause.message : 'Could not test LLM.', 'fail')
	} finally {
		btnTestLlm.disabled = false
	}
}

async function testJev(): Promise<void> {
	btnTestJev.disabled = true
	testStatus(jevTestStatus, 'Testing…')
	try {
		const result = await window.flowSetup.testJev({ token: jevToken.value })
		testStatus(jevTestStatus, `✓ Jev responded via ${result.provider}.`, 'ok')
	} catch (cause) {
		testStatus(jevTestStatus, cause instanceof Error ? cause.message : 'Could not test Jev.', 'fail')
	} finally {
		btnTestJev.disabled = false
	}
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
	renderLlm()
	renderJev()
	dotMic.className = `dot ${state.permissions.microphone}`
	dotAx.className = `dot ${state.permissions.accessibility}`
	dotIm.className = `dot ${state.permissions.inputMonitoring ?? 'unknown'}`
	btnMic.disabled = state.permissions.microphone === 'granted'
	btnMic.textContent = btnMic.disabled ? 'Enabled ✓' : 'Enable Microphone'
	axHint.innerHTML = state.permissions.axHint ?? DEFAULT_AX_HINT
	btnAx.textContent = state.permissions.accessibility === 'granted' ? 'Granted ✓ — re-open Settings' : 'Open Accessibility Settings'
	btnIm.textContent = state.permissions.inputMonitoring === 'granted' ? 'Enabled ✓ — re-open Settings' : 'Open Input Monitoring Settings'
	btnRestart.classList.toggle('hidden', state.permissions.accessibility === 'granted')
	btnDone.disabled = !state.setup.configured || state.permissions.microphone !== 'granted' || state.permissions.accessibility !== 'granted'
}

providerSelect.onchange = () => {
	clearSttTest()
	const keepSaved = providerSelect.value === state?.setup.provider
	selectProvider(providerSelect.value, keepSaved ? state?.setup.model : undefined, keepSaved ? state?.setup.language : undefined)
}
modelSearch.oninput = () => filterModels()
modelSelect.onchange = () => {
	clearSttTest()
	renderModelHint()
	buildLanguageOptions(langSelect.value || undefined)
}
langSearch.oninput = () => filterLanguages()
langSelect.onchange = () => {
	clearSttTest()
	renderLanguageHint()
}
token.oninput = clearSttTest
accountId.oninput = clearSttTest
gatewayId.oninput = clearSttTest
llmBaseUrl.oninput = clearLlmTest
llmModel.oninput = clearLlmTest
llmToken.oninput = clearLlmTest
jevToken.oninput = clearJevTest
btnTestStt.onclick = () => void testStt()
btnTestLlm.onclick = () => void testLlm()
btnTestJev.onclick = () => void testJev()
btnSave.onclick = () =>
	void (async () => {
		error.textContent = ''
		btnSave.disabled = true
		try {
			await window.flowSetup.save({ provider: providerId, accountId: accountId.value, gatewayId: gatewayId.value, model: modelSelect.value, language: langSelect.value, token: token.value })
			token.value = ''
			// The LLM section is optional: untouched means skip, a new key or
			// an already-saved one means persist (empty key keeps the saved key).
			if (llmToken.value.trim() !== '' || state?.llm.configured) {
				await window.flowSetup.saveLlm({ baseUrl: llmBaseUrl.value, model: llmModel.value, token: llmToken.value })
				llmToken.value = ''
			}
			if (jevToken.value.trim() !== '' || state?.jev.configured) {
				await window.flowSetup.saveJev({ token: jevToken.value })
				jevToken.value = ''
			}
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
btnRestart.onclick = () => void window.flowSetup.restart()
btnDone.onclick = () => void window.flowSetup.complete().then((started) => started && window.close())

void refresh().then(() => (state?.setup.configured ? showPermissions() : showSetup()))
setInterval(() => void refresh(), 1500)
