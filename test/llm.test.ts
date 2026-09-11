import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLlmConfigured, llmStatus, loadLlmToken, loadSettings, saveLlmSetup } from '../src/main/settings'

const hoisted = vi.hoisted(() => ({ userData: '/tmp/flow-llm-test' }))

vi.mock('electron', () => ({
	app: { getPath: () => hoisted.userData },
	safeStorage: { isEncryptionAvailable: () => false },
}))

import { LlmError, OpenAiCompatibleLlm, createLlmClient, truncateForSummary } from '../src/services/llm'

let savedKey: string | undefined

beforeEach(() => {
	savedKey = process.env.LLM_API_KEY
	delete process.env.LLM_API_KEY
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
	vi.unstubAllGlobals()
})

afterEach(() => {
	if (savedKey === undefined) delete process.env.LLM_API_KEY
	else process.env.LLM_API_KEY = savedKey
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
	vi.unstubAllGlobals()
})

function chatResponse(content: unknown, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
}

describe('llm settings', () => {
	it('defaults to the OpenAI endpoint and a small model', () => {
		const settings = loadSettings()
		expect(settings.llmBaseUrl).toBe('https://api.openai.com/v1')
		expect(settings.llmModel).toBe('gpt-4o-mini')
		expect(isLlmConfigured()).toBe(false)
	})

	it('saves endpoint, model, and key, and reports configured', () => {
		const status = saveLlmSetup({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3', token: 'sekret' })
		expect(status).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3', configured: true })
		expect(loadLlmToken()).toBe('sekret')
		expect(llmStatus().configured).toBe(true)
	})

	it('falls back to defaults for a blank endpoint or model', () => {
		const status = saveLlmSetup({ baseUrl: '  ', model: '', token: 'sekret' })
		expect(status.baseUrl).toBe('https://api.openai.com/v1')
		expect(status.model).toBe('gpt-4o-mini')
	})

	it('keeps the saved key when the token is blank', () => {
		saveLlmSetup({ baseUrl: '', model: '', token: 'first' })
		saveLlmSetup({ baseUrl: '', model: '', token: '  ' })
		expect(loadLlmToken()).toBe('first')
	})

	it('rejects a non-URL endpoint', () => {
		expect(() => saveLlmSetup({ baseUrl: 'not a url', model: 'm', token: 't' })).toThrow()
	})

	it('requires a key when none is saved yet', () => {
		expect(() => saveLlmSetup({ baseUrl: '', model: '', token: '' })).toThrow('API key')
	})

	it('accepts a key from the environment', () => {
		process.env.LLM_API_KEY = 'env-key'
		expect(loadLlmToken()).toBe('env-key')
		expect(isLlmConfigured()).toBe(true)
	})
})

describe('truncateForSummary', () => {
	it('passes short transcripts through untouched', () => {
		expect(truncateForSummary('hello')).toBe('hello')
	})

	it('keeps the head and tail of long transcripts with a marker', () => {
		const text = 'x'.repeat(200000)
		const out = truncateForSummary(text)
		expect(out.length).toBeLessThan(text.length)
		expect(out).toContain('trimmed')
		expect(out.startsWith('x'.repeat(100))).toBe(true)
		expect(out.endsWith('x'.repeat(100))).toBe(true)
	})
})

describe('OpenAiCompatibleLlm', () => {
	it('posts the transcript as a chat completion and returns the content', async () => {
		const fetchMock = vi.fn().mockResolvedValue(chatResponse('  Recap: stuff.  '))
		vi.stubGlobal('fetch', fetchMock)
		const text = await new OpenAiCompatibleLlm('https://llm.test/v1', 'tok', 'mini').summarize('meeting words')
		expect(text).toBe('Recap: stuff.')
		const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://llm.test/v1/chat/completions')
		expect((request.headers as Record<string, string>).Authorization).toBe(`Bearer ${'tok'}`)
		const body = JSON.parse(String(request.body)) as { model: string; messages: Array<{ role: string; content: string }> }
		expect(body.model).toBe('mini')
		expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
		expect(body.messages[1].content).toBe('meeting words')
	})

	it('strips a trailing slash from the base URL', async () => {
		const fetchMock = vi.fn().mockResolvedValue(chatResponse('ok'))
		vi.stubGlobal('fetch', fetchMock)
		await new OpenAiCompatibleLlm('https://llm.test/v1/', 'tok', 'mini').summarize('x')
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.test/v1/chat/completions')
	})

	it('maps failures to auth, provider, network, and empty errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
		await expect(new OpenAiCompatibleLlm('https://llm.test', 'bad', 'm').summarize('x')).rejects.toMatchObject({ kind: 'auth' })
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })))
		await expect(new OpenAiCompatibleLlm('https://llm.test', 'tok', 'm').summarize('x')).rejects.toMatchObject({ kind: 'provider', message: expect.stringContaining('boom') })
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
		await expect(new OpenAiCompatibleLlm('https://llm.test', 'tok', 'm').summarize('x')).rejects.toMatchObject({ kind: 'network' })
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('   ')))
		await expect(new OpenAiCompatibleLlm('https://llm.test', 'tok', 'm').summarize('x')).rejects.toMatchObject({ kind: 'empty' })
	})

	it('creates no client without a key', () => {
		expect(createLlmClient()).toBeNull()
		process.env.LLM_API_KEY = 'env-key'
		expect(createLlmClient()).toBeInstanceOf(OpenAiCompatibleLlm)
	})

	it('throws without a token', async () => {
		await expect(new OpenAiCompatibleLlm('https://llm.test', '', 'm').summarize('x')).rejects.toBeInstanceOf(LlmError)
	})
})
