import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDERS, isProviderModel, loadProviderToken, loadSettings, modelLanguages, resolveLanguage, resolveProviderModel, saveProviderSetup } from '../src/main/settings'

const hoisted = vi.hoisted(() => ({ userData: '/tmp/flow-settings-key-test' }))

vi.mock('electron', () => ({
	app: { getPath: () => hoisted.userData },
	safeStorage: { isEncryptionAvailable: () => false },
}))

const TOKEN_ENV_KEYS = [
	'CLOUDFLARE_AI_GATEWAY_TOKEN',
	'CLOUDFLARE_API_TOKEN',
	'OPENROUTER_API_KEY',
	'OPENAI_API_KEY',
	'AI_GATEWAY_API_KEY',
	'DEEPGRAM_API_KEY',
	'ASSEMBLYAI_API_KEY',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
	savedEnv = {}
	for (const key of TOKEN_ENV_KEYS) {
		savedEnv[key] = process.env[key]
		delete process.env[key]
	}
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
})

afterEach(() => {
	for (const key of TOKEN_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key]
		else process.env[key] = savedEnv[key]
	}
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
})
import {
	AssemblyAiStt,
	CloudflareGatewayStt,
	DeepgramStt,
	OpenAiCompatibleStt,
	VercelGatewayStt,
	buildGatewayTranscriptionsUrl,
	getAudioFormatFromMimeType,
} from '../src/services/stt'

const audio = { audio: Buffer.alloc(4096), filename: 'flow.webm', mimeType: 'audio/webm' }

describe('gateway url', () => {
	it('builds the OpenAI-compatible transcriptions URL through AI Gateway', () => {
		expect(buildGatewayTranscriptionsUrl('acct123', 'flow')).toBe(
			'https://gateway.ai.cloudflare.com/v1/acct123/flow/openai/audio/transcriptions',
		)
	})
})

describe('provider defaults', () => {
	it('assigns a supported transcription model to every onboarding choice', () => {
		expect(PROVIDERS.cloudflare.defaultModel).toBe('@cf/openai/whisper-large-v3-turbo')
		expect(PROVIDERS.openrouter.defaultModel).toBe('openai/whisper-1')
		expect(PROVIDERS.openai.defaultModel).toBe('gpt-4o-mini-transcribe')
		expect(PROVIDERS.vercel.defaultModel).toBe('openai/whisper-1')
		expect(PROVIDERS.deepgram.defaultModel).toBe('nova-3')
		expect(PROVIDERS.assemblyai.defaultModel).toBe('universal-3-5-pro')
	})
})

describe('provider model catalog', () => {
	it('lists every default model inside its provider catalog with unique ids', () => {
		for (const definition of Object.values(PROVIDERS)) {
			expect(definition.models.length).toBeGreaterThan(0)
			expect(definition.models.map((option) => option.id)).toContain(definition.defaultModel)
			expect(new Set(definition.models.map((option) => option.id)).size).toBe(definition.models.length)
		}
	})

	it('offers the current best models per provider', () => {
		expect(PROVIDERS.openai.models.map((option) => option.id)).toEqual(
			expect.arrayContaining(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']),
		)
		expect(PROVIDERS.deepgram.models.map((option) => option.id)).toEqual(
			expect.arrayContaining(['nova-3', 'nova-2', 'nova-3-medical', 'nova-2-meeting', 'nova-2-phonecall', 'whisper-large']),
		)
		// Flux is streaming-only (wss /v2/listen) and fails on the pre-recorded
		// POST /v1/listen endpoint, so it must stay out of the picker.
		expect(PROVIDERS.deepgram.models.map((option) => option.id)).not.toContain('flux-general-en')
		expect(PROVIDERS.deepgram.models.map((option) => option.id)).not.toContain('flux-general-multi')
		expect(PROVIDERS.assemblyai.models.map((option) => option.id)).toEqual(expect.arrayContaining(['universal-3-5-pro', 'universal-2']))
		expect(PROVIDERS.assemblyai.models.map((option) => option.id)).not.toContain('universal-3-pro')
		expect(PROVIDERS.openrouter.models.map((option) => option.id)).toEqual(
			expect.arrayContaining(['openai/whisper-1', 'openai/gpt-4o-transcribe', 'deepgram/nova-3']),
		)
	})

	it('resolves unknown or missing models back to the provider default', () => {
		expect(isProviderModel('openai', 'gpt-4o-transcribe')).toBe(true)
		expect(isProviderModel('openai', 'nova-3')).toBe(false)
		expect(resolveProviderModel('openai', 'gpt-4o-transcribe')).toBe('gpt-4o-transcribe')
		expect(resolveProviderModel('openai', 'not-a-model')).toBe(PROVIDERS.openai.defaultModel)
		expect(resolveProviderModel('deepgram', undefined)).toBe('nova-3')
	})
})

describe('provider language support', () => {
	it('gives every model a language list; Vercel models are auto-detect only', () => {
		for (const [id, definition] of Object.entries(PROVIDERS)) {
			for (const option of definition.models) {
				expect(Array.isArray(option.languages)).toBe(true)
				if (id === 'vercel') expect(option.languages).toEqual([])
			}
		}
	})

	it('restricts domain models to English only', () => {
		for (const id of ['nova-3-medical', 'nova-2-meeting', 'nova-2-phonecall', '@cf/openai/whisper-tiny-en']) {
			const owner = Object.entries(PROVIDERS).find(([, definition]) => definition.models.some((option) => option.id === id))
			expect(owner).toBeDefined()
			expect(modelLanguages(owner?.[0] as keyof typeof PROVIDERS, id)).toEqual(['en'])
		}
	})

	it('reflects documented coverage: nova-3 code-switching, AssemblyAI fallback chain', () => {
		expect(modelLanguages('deepgram', 'nova-3')).toEqual(expect.arrayContaining(['en', 'es', 'multi']))
		expect(modelLanguages('deepgram', 'nova-2')).not.toContain('multi')
		for (const code of modelLanguages('deepgram', 'nova-2')) {
			expect(modelLanguages('deepgram', 'nova-3')).toContain(code)
		}
		for (const code of modelLanguages('assemblyai', 'universal-3-5-pro')) {
			expect(modelLanguages('assemblyai', 'universal-2')).toContain(code)
		}
	})

	it('uses the full Whisper language set for whisper-1', () => {
		const whisper = modelLanguages('openai', 'whisper-1')
		expect(whisper.length).toBeGreaterThanOrEqual(98)
		expect(whisper).toEqual(expect.arrayContaining(['en', 'es', 'yue']))
	})

	it('resolves unknown or mismatched languages back to auto-detect', () => {
		expect(resolveLanguage('deepgram', 'nova-3', 'es')).toBe('es')
		expect(resolveLanguage('deepgram', 'nova-2', 'multi')).toBe('')
		expect(resolveLanguage('assemblyai', 'universal-3-5-pro', 'en_au')).toBe('en_au')
		expect(resolveLanguage('assemblyai', 'universal-3-5-pro', 'kk')).toBe('')
		expect(resolveLanguage('openai', 'whisper-1', 'xx')).toBe('')
		expect(resolveLanguage('openai', 'whisper-1', undefined)).toBe('')
		expect(resolveLanguage('vercel', 'openai/whisper-1', 'en')).toBe('')
	})
})

describe('saved API keys', () => {
	it('updates model and language with an empty token when a key is already saved', () => {
		saveProviderSetup({ provider: 'openai', token: 'secret-1' })
		const status = saveProviderSetup({ provider: 'openai', model: 'gpt-4o-transcribe', language: 'es', token: '' })
		expect(status.model).toBe('gpt-4o-transcribe')
		expect(status.language).toBe('es')
		expect(status.configured).toBe(true)
		expect(loadProviderToken('openai')).toBe('secret-1')
		expect(loadSettings().model).toBe('gpt-4o-transcribe')
	})

	it('requires a key when none is saved for the provider', () => {
		expect(() => saveProviderSetup({ provider: 'deepgram', token: '' })).toThrow(/API key/i)
		expect(() => saveProviderSetup({ provider: 'deepgram', token: '   ' })).toThrow(/API key/i)
	})

	it('replaces the saved key when a new token is entered', () => {
		saveProviderSetup({ provider: 'deepgram', token: 'old-key' })
		saveProviderSetup({ provider: 'deepgram', model: 'nova-2', token: 'new-key' })
		expect(loadProviderToken('deepgram')).toBe('new-key')
		expect(loadSettings().model).toBe('nova-2')
	})
})

describe('other STT providers', () => {
	it('posts OpenAI-compatible multipart audio', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'open router' }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const text = await new OpenAiCompatibleStt('OpenRouter', 'https://example.test/audio/transcriptions', 'tok', 'openai/whisper-1').transcribe(audio)
		expect(text).toBe('open router')
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/audio/transcriptions')
		expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>).Authorization).toBe('Bearer tok')
		vi.unstubAllGlobals()
	})

	it('uses Vercel’s transcription endpoint and model header', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'vercel' }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(new VercelGatewayStt('tok', 'openai/whisper-1').transcribe(audio)).resolves.toBe('vercel')
		const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/transcription-model')
		expect((request.headers as Record<string, string>)['ai-model-id']).toBe('openai/whisper-1')
		vi.unstubAllGlobals()
	})

	it('sends binary audio to Deepgram and returns its nested transcript', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'deep gram' }] }] } }), { status: 200 }),
		)
		vi.stubGlobal('fetch', fetchMock)
		await expect(new DeepgramStt('tok', 'nova-3').transcribe(audio)).resolves.toBe('deep gram')
		expect(fetchMock.mock.calls[0]?.[0]).toContain('model=nova-3')
		expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>).Authorization).toBe('Token tok')
		vi.unstubAllGlobals()
	})

	it('uploads, submits, and polls AssemblyAI until transcription completes', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ upload_url: 'https://upload.test/audio' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'transcript-id' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', text: 'assembly ai' }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(new AssemblyAiStt('tok', 'universal-3-5-pro').transcribe(audio)).resolves.toBe('assembly ai')
		expect(fetchMock.mock.calls).toHaveLength(3)
		const submitted = JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)
		expect(submitted.speech_models).toEqual(['universal-3-5-pro', 'universal-2'])
		vi.unstubAllGlobals()
	})
})

describe('audio format', () => {
	it('maps common mime types', () => {
		expect(getAudioFormatFromMimeType('audio/webm;codecs=opus')).toBe('webm')
		expect(getAudioFormatFromMimeType('audio/wav')).toBe('wav')
		expect(getAudioFormatFromMimeType('audio/mpeg')).toBe('mp3')
	})
})

describe('CloudflareGatewayStt', () => {
	it('posts multipart audio and returns trimmed text', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: '  hello flow ' }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const provider = new CloudflareGatewayStt('tok', { accountId: 'a', gatewayId: 'g', model: '@cf/openai/whisper-large-v3-turbo' })
		const text = await provider.transcribe(audio)
		expect(text).toBe('hello flow')
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toContain('/openai/audio/transcriptions')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
		vi.unstubAllGlobals()
	})

	it('throws auth error without token', async () => {
		const provider = new CloudflareGatewayStt('', { accountId: 'a', gatewayId: 'g', model: 'm' })
		await expect(provider.transcribe({ audio: Buffer.alloc(10), filename: 'f', mimeType: 'audio/webm' })).rejects.toThrow(/token/i)
	})
})
