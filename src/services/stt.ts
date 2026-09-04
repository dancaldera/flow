import { type FlowSettings, PROVIDERS, loadProviderToken } from '../main/settings'

export interface GatewayConfig {
	accountId: string
	gatewayId: string
	model: string
}

export interface TranscribeInput {
	audio: Buffer
	filename: string
	mimeType: string
	language?: string
}

export interface SttProvider {
	readonly name: string
	transcribe(input: TranscribeInput): Promise<string>
}

export function buildGatewayTranscriptionsUrl(accountId: string, gatewayId: string): string {
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai/audio/transcriptions`
}

export function getAudioFormatFromMimeType(mimeType: string): string {
	const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
	switch (normalized) {
		case 'audio/wav':
			return 'wav'
		case 'audio/mp3':
		case 'audio/mpeg':
			return 'mp3'
		case 'audio/mp4':
		case 'audio/m4a':
			return 'm4a'
		case 'audio/ogg':
			return 'ogg'
		case 'audio/flac':
			return 'flac'
		default:
			return 'webm'
	}
}

export class SttError extends Error {
	readonly kind: 'auth' | 'network' | 'provider' | 'empty' | 'too-long'
	constructor(kind: SttError['kind'], message: string) {
		super(message)
		this.kind = kind
	}
}

type ErrorResponse = { error?: { message?: string } | string; message?: string }

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

function errorMessage(body: ErrorResponse, fallback: string): string {
	return typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? fallback)
}

async function ensureResponse(response: Response, provider: string): Promise<Record<string, unknown>> {
	const data = await readJson(response)
	if (response.ok) return data
	if (response.status === 401 || response.status === 403) throw new SttError('auth', `${provider} authentication failed (${response.status}).`)
	throw new SttError('provider', `${provider} ${response.status}: ${errorMessage(data, response.statusText)}`)
}

function transcriptionForm(input: TranscribeInput, model: string): FormData {
	const form = new FormData()
	form.set('model', model)
	form.set('file', new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), input.filename)
	if (input.language) form.set('language', input.language)
	return form
}

export class CloudflareGatewayStt implements SttProvider {
	readonly name = 'cloudflare-gateway'
	constructor(
		private readonly token: string,
		private readonly config: GatewayConfig,
	) {}

	async transcribe(input: TranscribeInput): Promise<string> {
		if (!this.token) throw new SttError('auth', 'Missing Cloudflare AI Gateway token (Keychain empty).')
		if (!this.config.accountId || !this.config.gatewayId) {
			throw new SttError('auth', 'Missing Gateway account_id/gateway_id in settings.')
		}
		return transcribeMultipart(
			this.name,
			buildGatewayTranscriptionsUrl(this.config.accountId, this.config.gatewayId),
			this.token,
			this.config.model || PROVIDERS.cloudflare.defaultModel,
			input,
		)
	}
}

export class OpenAiCompatibleStt implements SttProvider {
	constructor(
		readonly name: string,
		private readonly endpoint: string,
		private readonly token: string,
		private readonly model: string,
	) {}

	async transcribe(input: TranscribeInput): Promise<string> {
		if (!this.token) throw new SttError('auth', `Missing ${this.name} API key.`)
		return transcribeMultipart(this.name, this.endpoint, this.token, this.model, input)
	}
}

async function transcribeMultipart(
	name: string,
	endpoint: string,
	token: string,
	model: string,
	input: TranscribeInput,
): Promise<string> {
	let response: Response
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: transcriptionForm(input, model),
		})
	} catch (error) {
		throw new SttError('network', `${name} unreachable: ${error instanceof Error ? error.message : String(error)}`)
	}
	const data = await ensureResponse(response, name)
	const text = typeof data.text === 'string' ? data.text.trim() : ''
	if (!text) throw new SttError('empty', 'No speech detected.')
	return text
}

export class VercelGatewayStt implements SttProvider {
	readonly name = 'vercel-ai-gateway'
	constructor(
		private readonly token: string,
		private readonly model: string,
	) {}

	async transcribe(input: TranscribeInput): Promise<string> {
		if (!this.token) throw new SttError('auth', 'Missing Vercel AI Gateway API key.')
		let response: Response
		try {
			response = await fetch('https://ai-gateway.vercel.sh/v4/ai/transcription-model', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.token}`,
					'ai-model-id': this.model,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ audio: input.audio.toString('base64'), mediaType: input.mimeType }),
			})
		} catch (error) {
			throw new SttError('network', `Vercel AI Gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
		}
		const data = await ensureResponse(response, this.name)
		const text = typeof data.text === 'string' ? data.text.trim() : ''
		if (!text) throw new SttError('empty', 'No speech detected.')
		return text
	}
}

export class DeepgramStt implements SttProvider {
	readonly name = 'deepgram'
	constructor(
		private readonly token: string,
		private readonly model: string,
	) {}

	async transcribe(input: TranscribeInput): Promise<string> {
		if (!this.token) throw new SttError('auth', 'Missing Deepgram API key.')
		const params = new URLSearchParams({ model: this.model, smart_format: 'true', dictation: 'true' })
		if (input.language) params.set('language', input.language)
		let response: Response
		try {
			response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
				method: 'POST',
				headers: { Authorization: `Token ${this.token}`, 'Content-Type': input.mimeType },
				body: new Uint8Array(input.audio),
			})
		} catch (error) {
			throw new SttError('network', `Deepgram unreachable: ${error instanceof Error ? error.message : String(error)}`)
		}
		const data = await ensureResponse(response, this.name)
		const text = (((data.results as Record<string, unknown> | undefined)?.channels as Array<Record<string, unknown>> | undefined)?.[0]
			?.alternatives as Array<Record<string, unknown>> | undefined)?.[0]?.transcript
		if (typeof text !== 'string' || !text.trim()) throw new SttError('empty', 'No speech detected.')
		return text.trim()
	}
}

export class AssemblyAiStt implements SttProvider {
	readonly name = 'assemblyai'
	constructor(
		private readonly token: string,
		private readonly model: string,
	) {}

	async transcribe(input: TranscribeInput): Promise<string> {
		if (!this.token) throw new SttError('auth', 'Missing AssemblyAI API key.')
		const headers = { authorization: this.token }
		let upload: Record<string, unknown>
		try {
			upload = await ensureResponse(
				await fetch('https://api.assemblyai.com/v2/upload', {
					method: 'POST',
					headers,
					body: new Uint8Array(input.audio),
				}),
				this.name,
			)
		} catch (error) {
			if (error instanceof SttError) throw error
			throw new SttError('network', `AssemblyAI unreachable: ${error instanceof Error ? error.message : String(error)}`)
		}
		if (typeof upload.upload_url !== 'string') throw new SttError('provider', 'AssemblyAI did not return an upload URL.')
		const request: Record<string, unknown> = {
			audio_url: upload.upload_url,
			speech_models: this.model === 'universal-3-5-pro' ? [this.model, 'universal-2'] : [this.model],
			language_detection: !input.language,
		}
		if (input.language) request.language_code = input.language
		const created = await ensureResponse(
			await fetch('https://api.assemblyai.com/v2/transcript', {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
			}),
			this.name,
		)
		if (typeof created.id !== 'string') throw new SttError('provider', 'AssemblyAI did not return a transcript ID.')
		for (let attempt = 0; attempt < 120; attempt += 1) {
			const result = await ensureResponse(
				await fetch(`https://api.assemblyai.com/v2/transcript/${created.id}`, { headers }),
				this.name,
			)
			if (result.status === 'completed') {
				if (typeof result.text !== 'string' || !result.text.trim()) throw new SttError('empty', 'No speech detected.')
				return result.text.trim()
			}
			if (result.status === 'error') throw new SttError('provider', errorMessage(result, 'AssemblyAI transcription failed.'))
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
		throw new SttError('too-long', 'AssemblyAI transcription timed out.')
	}
}

export function createSttProvider(settings: FlowSettings): SttProvider {
	const token = loadProviderToken(settings.provider)
	const model = settings.model || PROVIDERS[settings.provider].defaultModel
	switch (settings.provider) {
		case 'cloudflare':
			return new CloudflareGatewayStt(token, { accountId: settings.accountId, gatewayId: settings.gatewayId, model })
		case 'openrouter':
			return new OpenAiCompatibleStt('OpenRouter', 'https://openrouter.ai/api/v1/audio/transcriptions', token, model)
		case 'openai':
			return new OpenAiCompatibleStt('OpenAI', 'https://api.openai.com/v1/audio/transcriptions', token, model)
		case 'vercel':
			return new VercelGatewayStt(token, model)
		case 'deepgram':
			return new DeepgramStt(token, model)
		case 'assemblyai':
			return new AssemblyAiStt(token, model)
	}
}
