// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ProviderModel = { id: string; label: string; blurb: string; languages: string[] }
type Provider = { id: string; label: string; defaultModel: string; models: ProviderModel[]; needsAccountId: boolean; needsGatewayId: boolean }

const PROVIDERS: Provider[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		defaultModel: 'gpt-4o-mini-transcribe',
		models: [
			{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', blurb: 'Fast and cheap.', languages: ['en', 'es'] },
			{ id: 'whisper-1', label: 'Whisper 1', blurb: 'Legacy model.', languages: ['en', 'es', 'yue'] },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
	{
		id: 'cloudflare',
		label: 'Cloudflare AI Gateway',
		defaultModel: '@cf/openai/whisper',
		models: [{ id: '@cf/openai/whisper', label: 'Whisper Large v3', blurb: '', languages: ['en'] }],
		needsAccountId: true,
		needsGatewayId: true,
	},
	{
		id: 'deepgram',
		label: 'Deepgram',
		defaultModel: 'nova-3',
		models: [],
		needsAccountId: false,
		needsGatewayId: false,
	},
]

const calls: Array<{ method: string; arg?: unknown }> = []

function freshState() {
	return {
		permissions: { microphone: 'granted', accessibility: 'granted', inputMonitoring: 'granted' },
		setup: { provider: 'openai', model: 'whisper-1', language: 'es', configured: true },
		providers: PROVIDERS,
		configuredProviders: ['openai'],
		llm: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', configured: false },
		jev: { configured: false, provider: null },
		automation: {},
	}
}

let stateFixture = freshState()

function loadOnboarding(): Promise<void> {
	// The module grabs every id below at import time.
	document.body.innerHTML =
		'<section id="setup-step">' +
		'<select id="provider"></select>' +
		'<input id="model-search" /><select id="model"></select><div id="model-hint"></div>' +
		'<input id="language-search" /><select id="language"></select><div id="language-hint"></div>' +
		'<div id="cloudflare-fields"><input id="account-id" /><input id="gateway-id" /></div>' +
		'<input id="token" /><div id="key-status"></div><button id="btn-test-stt"></button><span id="stt-test-status"></span>' +
		'<input id="llm-base-url" /><input id="llm-model" /><input id="llm-token" /><div id="llm-status"></div><button id="btn-test-llm"></button><span id="llm-test-status"></span>' +
		'<input id="jev-token" /><div id="jev-status"></div><button id="btn-test-jev"></button><span id="jev-test-status"></span>' +
		'<div id="jev-ready" class="hidden"><span id="dot-jev-key"></span><span id="dot-jev-ax"></span><span id="dot-jev-se"></span><span id="txt-jev-se"></span><span id="dot-jev-finder"></span><span id="txt-jev-finder"></span><button id="btn-check-automation"></button><button id="btn-open-automation"></button><span id="jev-ready-status"></span></div>' +
		'<div id="error"></div><button id="btn-save">Continue</button>' +
		'</section>' +
		'<section id="permissions-step" class="hidden">' +
		'<span id="dot-mic"></span><button id="btn-mic"></button>' +
		'<span id="dot-ax"></span><p id="ax-hint"></p><button id="btn-ax"></button>' +
		'<span id="dot-im"></span><button id="btn-im"></button><button id="btn-restart"></button>' +
		'<button id="btn-change"></button><button id="btn-done"></button>' +
		'</section>'
	;(window as unknown as { flowSetup: unknown }).flowSetup = {
		get: () => Promise.resolve(stateFixture),
		save: (setup: unknown) => {
			calls.push({ method: 'save', arg: setup })
			return Promise.resolve({ provider: 'openai', model: 'whisper-1', language: 'es', configured: true })
		},
		saveLlm: (setup: unknown) => {
			calls.push({ method: 'saveLlm', arg: setup })
			return Promise.resolve(stateFixture.llm)
		},
		testStt: () => Promise.resolve({ provider: 'openai', model: 'whisper-1' }),
		testLlm: () => Promise.resolve({ model: 'gpt-4o-mini' }),
		saveJev: (setup: unknown) => {
			calls.push({ method: 'saveJev', arg: setup })
			return Promise.resolve(stateFixture.jev)
		},
		testJev: () => Promise.resolve({ provider: 'typesafe' }),
		checkAutomation: () => Promise.resolve(stateFixture.automation),
		openAutomation: () => Promise.resolve(),
		requestMic: () => Promise.resolve(true),
		promptAccessibility: () => Promise.resolve(),
		openInputMonitoring: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		complete: () => {
			calls.push({ method: 'complete' })
			return Promise.resolve(false)
		},
	}
	vi.resetModules()
	return import('../src/onboarding.js').then(() => undefined)
}

function el(id: string): HTMLElement {
	return document.getElementById(id) as HTMLElement
}

function input(id: string): HTMLInputElement {
	return document.getElementById(id) as HTMLInputElement
}

function select(id: string): HTMLSelectElement {
	return document.getElementById(id) as HTMLSelectElement
}

function optionValues(id: string): string[] {
	return Array.from(select(id).options).map((option) => option.value)
}

function choose(id: string, value: string): void {
	const element = select(id)
	element.value = value
	element.dispatchEvent(new Event('change'))
}

beforeEach(async () => {
	vi.useFakeTimers()
	calls.length = 0
	stateFixture = freshState()
	await loadOnboarding()
	await vi.waitFor(() => expect(select('provider').options.length).toBe(PROVIDERS.length))
})

afterEach(() => {
	vi.useRealTimers()
})

describe('provider picker', () => {
	it('restores the saved provider, model, and language', () => {
		expect(select('provider').value).toBe('openai')
		expect(select('model').value).toBe('whisper-1')
		expect(select('language').value).toBe('es')
		expect(optionValues('language')).toEqual(['', 'en', 'es', 'yue'])
	})

	it('shows the Cloudflare fields only when the provider needs them', () => {
		expect(el('cloudflare-fields').classList.contains('hidden')).toBe(true)
		choose('provider', 'cloudflare')
		expect(el('cloudflare-fields').classList.contains('hidden')).toBe(false)
		choose('provider', 'deepgram')
		expect(el('cloudflare-fields').classList.contains('hidden')).toBe(true)
	})

	it('marks providers with a saved key and resets the token field on switch', () => {
		expect(el('key-status').textContent).toMatch(/key saved for OpenAI/i)
		input('token').value = 'typed-but-unsaved'
		choose('provider', 'deepgram')
		expect(el('key-status').textContent).toMatch(/No API key saved for Deepgram/i)
		expect(input('token').value).toBe('')
	})

	it('falls back to a default-model option when a provider lists no models', () => {
		choose('provider', 'deepgram')
		expect(optionValues('model')).toEqual(['nova-3'])
		expect(optionValues('language')).toEqual([''])
	})

	it('restores the saved model and language when switching back', () => {
		choose('provider', 'deepgram')
		expect(select('model').value).toBe('nova-3')
		choose('provider', 'openai')
		expect(select('model').value).toBe('whisper-1')
		expect(select('language').value).toBe('es')
	})
})

describe('search filtering', () => {
	it('hides model options that do not match the search', () => {
		input('model-search').value = 'whisper'
		input('model-search').dispatchEvent(new Event('input'))
		const options = Array.from(select('model').options)
		expect(options.find((option) => option.value === 'whisper-1')?.hidden).toBe(false)
		expect(options.find((option) => option.value === 'gpt-4o-mini-transcribe')?.hidden).toBe(true)
	})

	it('reselects the first visible option when the selection is filtered out', () => {
		select('model').value = 'gpt-4o-mini-transcribe'
		input('model-search').value = 'whisper'
		input('model-search').dispatchEvent(new Event('input'))
		expect(select('model').value).toBe('whisper-1')
	})

	it('filters language options by name or code', () => {
		input('language-search').value = 'yue'
		input('language-search').dispatchEvent(new Event('input'))
		const visible = Array.from(select('language').options).filter((option) => !option.hidden)
		expect(visible.map((option) => option.value)).toEqual(['yue'])
		// The hidden previous selection is reseated on the first visible option.
		expect(select('language').value).toBe('yue')
	})
})

describe('language options', () => {
	it('rebuilds the list when the model changes', () => {
		choose('model', 'gpt-4o-mini-transcribe')
		expect(optionValues('language')).toEqual(['', 'en', 'es'])
		expect(select('language').value).toBe('es')
	})

	it('drops a saved language the new model does not support', () => {
		choose('model', 'gpt-4o-mini-transcribe')
		expect(select('language').value).toBe('es')
		choose('provider', 'cloudflare')
		// cloudflare's model supports only 'en'; the saved 'es' must not survive.
		expect(select('language').value).toBe('')
	})
})

describe('save and permissions flow', () => {
	it('saves the selected setup and advances to the permissions step', async () => {
		input('token').value = 'fresh-key'
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() =>
			expect(calls).toContainEqual({
				method: 'save',
				arg: { provider: 'openai', accountId: '', gatewayId: '', model: 'whisper-1', language: 'es', token: 'fresh-key' },
			}),
		)
		expect(el('setup-step').classList.contains('hidden')).toBe(true)
		expect(el('permissions-step').classList.contains('hidden')).toBe(false)
	})

	it('stays on the setup step when the save fails', async () => {
		// A configured install lands on the permissions step; "Change setup" is
		// the real path back to the form.
		;(el('btn-change') as HTMLButtonElement).click()
		;(window as unknown as { flowSetup: { save: () => Promise<never> } }).flowSetup.save = () => Promise.reject(new Error('bad key'))
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(el('error').textContent).toBe('bad key'))
		expect(el('setup-step').classList.contains('hidden')).toBe(false)
		expect(el('permissions-step').classList.contains('hidden')).toBe(true)
	})

	it('enables Done only when configured with mic and accessibility granted', async () => {
		expect((el('btn-done') as HTMLButtonElement).disabled).toBe(false)
		stateFixture = { ...freshState(), permissions: { microphone: 'granted', accessibility: 'missing', inputMonitoring: 'missing' } }
		await vi.advanceTimersByTimeAsync(1600)
		await vi.waitFor(() => expect((el('btn-done') as HTMLButtonElement).disabled).toBe(true))
	})

	it('calls complete when Done is clicked', async () => {
		;(el('btn-done') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'complete' }))
	})
})
