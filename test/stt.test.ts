import { describe, expect, it, vi } from 'vitest'
import { PROVIDERS } from '../src/main/settings'
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
