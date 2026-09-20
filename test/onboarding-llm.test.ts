// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; arg?: unknown }> = []
let llmState = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', configured: false }
let jevState: { configured: boolean; provider: 'openrouter' | 'typesafe' | null } = { configured: false, provider: null }
let automationState: { 'System Events'?: string; Finder?: string } = {}
let saveLlmError: string | null = null

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
		'<span id="dot-fn"></span><p id="fn-hint"></p>' +
		'<span id="dot-im"></span><button id="btn-im"></button><span id="dot-ax"></span><button id="btn-ax"></button>' +
		'<button id="btn-restart"></button>' +
		'<button id="btn-change"></button><button id="btn-done"></button>' +
		'</section>'
	;(window as unknown as { flowSetup: unknown }).flowSetup = {
		get: () =>
			Promise.resolve({
				permissions: { microphone: 'granted', accessibility: 'granted', inputMonitoring: 'granted' },
				setup: { provider: 'openai', model: 'whisper-1', language: '', configured: false },
				providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'whisper-1', models: [], needsAccountId: false, needsGatewayId: false }],
				configuredProviders: ['openai'],
				llm: llmState,
			jev: jevState,
			automation: automationState,
			}),
		save: (setup: unknown) => {
			calls.push({ method: 'save', arg: setup })
			return Promise.resolve({ provider: 'openai', model: 'whisper-1', language: '', configured: true })
		},
		saveLlm: (setup: unknown) => {
			calls.push({ method: 'saveLlm', arg: setup })
			if (saveLlmError) return Promise.reject(new Error(saveLlmError))
			llmState = { ...(setup as typeof llmState), configured: true }
			return Promise.resolve(llmState)
		},
		testStt: (setup: unknown) => {
			calls.push({ method: 'testStt', arg: setup })
			return Promise.resolve({ provider: 'openai', model: 'whisper-1' })
		},
		testLlm: (setup: unknown) => {
			calls.push({ method: 'testLlm', arg: setup })
			return Promise.resolve({ model: (setup as { model: string }).model })
		},
		saveJev: (setup: unknown) => {
			calls.push({ method: 'saveJev', arg: setup })
			jevState = { configured: true, provider: 'typesafe' }
			return Promise.resolve(jevState)
		},
		testJev: (setup: unknown) => {
			calls.push({ method: 'testJev', arg: setup })
			return Promise.resolve({ provider: 'typesafe' })
		},
		checkAutomation: () => {
			calls.push({ method: 'checkAutomation' })
			automationState = { 'System Events': 'granted', Finder: 'granted' }
			return Promise.resolve(automationState)
		},
		openAutomation: () => {
			calls.push({ method: 'openAutomation' })
			return Promise.resolve()
		},
		requestMic: () => Promise.resolve(true),
		promptAccessibility: () => Promise.resolve(),
		openInputMonitoring: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		complete: () => Promise.resolve(true),
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

beforeEach(async () => {
	vi.useFakeTimers()
	calls.length = 0
	saveLlmError = null
	llmState = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', configured: false }
	jevState = { configured: false, provider: null }
	automationState = {}
	await loadOnboarding()
	await vi.waitFor(() => expect((document.getElementById('provider') as HTMLSelectElement).options.length).toBeGreaterThan(0))
})

afterEach(() => {
	vi.useRealTimers()
})

describe('onboarding llm section', () => {
	it('prefills the endpoint and model and shows the unconfigured status', () => {
		expect(input('llm-base-url').value).toBe('https://api.openai.com/v1')
		expect(input('llm-model').value).toBe('gpt-4o-mini')
		expect(el('llm-status').textContent).toMatch(/no .*key/i)
	})

	it('shows the saved status when a key is configured', async () => {
		llmState = { baseUrl: 'https://x.test', model: 'm', configured: true }
		await vi.advanceTimersByTimeAsync(1600)
		await vi.waitFor(() => expect(el('llm-status').textContent).toMatch(/saved/i))
	})

	it('skips the llm save when untouched', async () => {
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'save', arg: expect.anything() }))
		await vi.advanceTimersByTimeAsync(100)
		expect(calls.map((c) => c.method)).not.toContain('saveLlm')
	})

	it('saves the llm setup alongside the provider setup', async () => {
		input('llm-base-url').value = 'https://api.groq.com/openai/v1'
		input('llm-model').value = 'llama-3'
		input('llm-token').value = 'sekret'
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'saveLlm', arg: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3', token: 'sekret' } }))
		expect(el('setup-step').classList.contains('hidden')).toBe(true)
	})

	it('blocks progress when the llm save fails', async () => {
		input('llm-token').value = 'sekret'
		saveLlmError = 'LLM endpoint must be an http(s) URL.'
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(el('error').textContent).toBe('LLM endpoint must be an http(s) URL.'))
		expect(el('setup-step').classList.contains('hidden')).toBe(false)
	})

	it('tests the selected LLM settings without saving them', async () => {
		input('llm-base-url').value = 'https://llm.test/v1'
		input('llm-model').value = 'small'
		input('llm-token').value = 'sekret'
		;(el('btn-test-llm') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'testLlm', arg: { baseUrl: 'https://llm.test/v1', model: 'small', token: 'sekret' } }))
		expect(calls.map((c) => c.method)).not.toContain('saveLlm')
		expect(el('llm-test-status').textContent).toMatch(/responded/i)
	})

	it('tests the selected STT settings without saving them', async () => {
		input('token').value = 'stt-secret'
		;(el('btn-test-stt') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({
			method: 'testStt',
			arg: { provider: 'openai', accountId: '', gatewayId: '', model: 'whisper-1', language: '', token: 'stt-secret' },
		}))
		expect(calls.map((c) => c.method)).not.toContain('save')
		expect(el('stt-test-status').textContent).toMatch(/accepted/i)
	})
})

describe('onboarding jev section', () => {
	it('shows the unconfigured hint when no jev key is saved', () => {
		expect(el('jev-status').textContent).toMatch(/no jev key/i)
	})

	it('saves the jev key alongside the provider setup', async () => {
		input('jev-token').value = 'jev-secret'
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'saveJev', arg: { token: 'jev-secret' } }))
		expect(el('setup-step').classList.contains('hidden')).toBe(true)
	})

	it('skips the jev save when untouched', async () => {
		;(el('btn-save') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'save', arg: expect.anything() }))
		await vi.advanceTimersByTimeAsync(100)
		expect(calls.map((c) => c.method)).not.toContain('saveJev')
	})

	it('tests the jev key without saving it', async () => {
		input('jev-token').value = 'jev-secret'
		;(el('btn-test-jev') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'testJev', arg: { token: 'jev-secret' } }))
		expect(calls.map((c) => c.method)).not.toContain('saveJev')
		expect(el('jev-test-status').textContent).toMatch(/responded/i)
	})

	it('keeps the readiness checklist hidden while unconfigured', () => {
		expect(el('jev-ready').classList.contains('hidden')).toBe(true)
	})

	it('shows the readiness checklist with dots when a jev key is saved', async () => {
		jevState = { configured: true, provider: 'typesafe' }
		await vi.advanceTimersByTimeAsync(1600)
		await vi.waitFor(() => expect(el('jev-ready').classList.contains('hidden')).toBe(false))
		expect(el('dot-jev-key').className).toBe('dot granted')
		expect(el('dot-jev-ax').className).toBe('dot granted')
		expect(el('dot-jev-se').className).toBe('dot unknown')
		expect(el('txt-jev-se').textContent).toMatch(/not checked yet/)
	})

	it('checks automation access from the checklist button', async () => {
		jevState = { configured: true, provider: 'typesafe' }
		;(el('btn-check-automation') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(el('jev-ready-status').textContent).toMatch(/all set/i))
		expect(calls.map((c) => c.method)).toContain('checkAutomation')
	})
})
