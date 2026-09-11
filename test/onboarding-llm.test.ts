// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; arg?: unknown }> = []
let llmState = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', configured: false }
let saveLlmError: string | null = null

function loadOnboarding(): Promise<void> {
	// The module grabs every id below at import time.
	document.body.innerHTML =
		'<section id="setup-step">' +
		'<select id="provider"></select>' +
		'<input id="model-search" /><select id="model"></select><div id="model-hint"></div>' +
		'<input id="language-search" /><select id="language"></select><div id="language-hint"></div>' +
		'<div id="cloudflare-fields"><input id="account-id" /><input id="gateway-id" /></div>' +
		'<input id="token" /><div id="key-status"></div>' +
		'<input id="llm-base-url" /><input id="llm-model" /><input id="llm-token" /><div id="llm-status"></div>' +
		'<div id="error"></div><button id="btn-save">Continue</button>' +
		'</section>' +
		'<section id="permissions-step" class="hidden">' +
		'<span id="dot-mic"></span><button id="btn-mic"></button>' +
		'<span id="dot-ax"></span><p id="ax-hint"></p><button id="btn-ax"></button>' +
		'<span id="dot-im"></span><button id="btn-im"></button><button id="btn-restart"></button>' +
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
})
