import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
export const STT_PROVIDERS = ['cloudflare', 'openrouter', 'openai', 'vercel', 'deepgram', 'assemblyai'] as const
export type SttProviderId = (typeof STT_PROVIDERS)[number]

export interface ProviderModelOption {
	id: string
	label: string
	blurb: string
	// Language codes accepted by this model, exactly as its provider's API
	// expects them. [] means the app sends no language hint (auto-detect only).
	languages: string[]
}

// Whisper-family `language` hint (ISO-639-1). Source: openai/whisper tokenizer
// LANGUAGES. Shared by whisper-1, Cloudflare Workers AI whisper models, and
// Deepgram Whisper Cloud, which all accept the same codes.
const WHISPER_LANGUAGES = [
	'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
	'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
	'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
	'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
	'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk',
	'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
	'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
	'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
	'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
	'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
]

// gpt-4o-transcribe / gpt-4o-mini-transcribe accept an ISO-639-1 `language`
// hint, but OpenAI publishes no closed code list for them, so we offer major
// languages only. Anything else is covered by auto-detect (empty string).
const GPT_TRANSCRIBE_LANGUAGES = [
	'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk',
	'tr', 'el', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sr', 'sl',
	'da', 'sv', 'no', 'fi', 'ar', 'he', 'fa', 'ur', 'hi', 'bn',
	'ta', 'te', 'th', 'vi', 'id', 'ms', 'tl', 'ko', 'ja', 'zh',
]

// Deepgram `language` values. Source: Deepgram models & languages overview.
// Bare codes cover all regional accents; `multi` enables code-switching
// (nova-3 only).
const NOVA3_LANGUAGES = [
	'multi', 'af', 'ar', 'as', 'be', 'bg', 'bn', 'bs', 'ca', 'cs',
	'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'gu',
	'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'ja', 'ka', 'kk',
	'kn', 'ko', 'lt', 'lv', 'mk', 'mn', 'mr', 'ms', 'ne', 'nl',
	'no', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr',
	'sv', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh',
]

const NOVA2_LANGUAGES = [
	'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi',
	'fr', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms',
	'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'th', 'tr',
	'uk', 'vi', 'zh',
]

// AssemblyAI `language_code` values. Source: AssemblyAI supported-languages
// docs. Universal-3.5 Pro covers 18 languages; anything else falls back to
// Universal-2 automatically via the speech_models request array.
const ASSEMBLYAI_U35P_LANGUAGES = [
	'en', 'en_au', 'en_uk', 'en_us', 'es', 'fr', 'de', 'it', 'pt', 'ar',
	'da', 'nl', 'fi', 'he', 'hi', 'ja', 'zh', 'no', 'sv', 'tr', 'vi',
]

const ASSEMBLYAI_U2_LANGUAGES = [
	'en', 'en_au', 'en_uk', 'en_us', 'es', 'fr', 'de', 'it', 'pt', 'nl',
	'hi', 'ja', 'zh', 'fi', 'ko', 'pl', 'ru', 'tr', 'uk', 'vi',
	'af', 'sq', 'am', 'ar', 'hy', 'as', 'az', 'ba', 'eu', 'be',
	'bn', 'bs', 'br', 'bg', 'my', 'ca', 'hr', 'cs', 'da', 'et',
	'fo', 'gl', 'ka', 'el', 'gu', 'ht', 'ha', 'haw', 'he', 'hu',
	'is', 'id', 'jw', 'kn', 'kk', 'km', 'lo', 'la', 'lv', 'ln',
	'lt', 'lb', 'mk', 'mg', 'ms', 'ml', 'mt', 'mi', 'mr', 'mn',
	'ne', 'no', 'nn', 'oc', 'pa', 'ps', 'fa', 'ro', 'sa', 'sr',
	'sn', 'sd', 'si', 'sk', 'sl', 'so', 'su', 'sw', 'sv', 'de_ch',
	'tl', 'tg', 'ta', 'tt', 'te', 'th', 'bo', 'tk', 'ur', 'uz',
	'cy', 'yi', 'yo',
]

const ENGLISH_ONLY = ['en']

// The Vercel AI Gateway transcription endpoint wrapper in stt.ts sends no
// language field, so these models offer auto-detect only for now.
const AUTO_ONLY: string[] = []

export interface ProviderDefinition {
	label: string
	defaultModel: string
	models: ProviderModelOption[]
	needsAccountId: boolean
	needsGatewayId: boolean
}

export const PROVIDERS: Record<SttProviderId, ProviderDefinition> = {
	cloudflare: {
		label: 'Cloudflare AI Gateway',
		defaultModel: '@cf/openai/whisper-large-v3-turbo',
		models: [
			{ id: '@cf/openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', blurb: 'Best quality Workers AI model. Default.', languages: WHISPER_LANGUAGES },
			{ id: '@cf/openai/whisper', label: 'Whisper Large v3', blurb: 'Balanced fallback when Turbo is unavailable.', languages: WHISPER_LANGUAGES },
			{ id: '@cf/openai/whisper-tiny-en', label: 'Whisper Tiny English', blurb: 'Fastest and cheapest. English-only, lower accuracy.', languages: ENGLISH_ONLY },
		],
		needsAccountId: true,
		needsGatewayId: true,
	},
	openrouter: {
		label: 'OpenRouter',
		defaultModel: 'openai/whisper-1',
		models: [
			{ id: 'openai/whisper-1', label: 'Whisper 1', blurb: 'Widest compatibility. Default.', languages: WHISPER_LANGUAGES },
			{ id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe', blurb: 'Best accuracy, incl. accented and noisy speech.', languages: GPT_TRANSCRIBE_LANGUAGES },
			{ id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', blurb: 'Faster and cheaper, slightly lower accuracy.', languages: GPT_TRANSCRIBE_LANGUAGES },
			{ id: 'deepgram/nova-3', label: 'Deepgram Nova 3', blurb: 'Deepgram flagship routed through OpenRouter.', languages: NOVA3_LANGUAGES },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
	openai: {
		label: 'OpenAI',
		defaultModel: 'gpt-4o-mini-transcribe',
		models: [
			{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', blurb: 'Fast and cheap. Default.', languages: GPT_TRANSCRIBE_LANGUAGES },
			{ id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', blurb: 'Best accuracy, incl. accented and noisy speech.', languages: GPT_TRANSCRIBE_LANGUAGES },
			{ id: 'whisper-1', label: 'Whisper 1', blurb: 'Legacy model. Pick for verbose_json timestamps support.', languages: WHISPER_LANGUAGES },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
	vercel: {
		label: 'Vercel AI Gateway',
		defaultModel: 'openai/whisper-1',
		models: [
			{ id: 'openai/whisper-1', label: 'Whisper 1', blurb: 'Widest compatibility. Default.', languages: AUTO_ONLY },
			{ id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe', blurb: 'Best accuracy, incl. accented and noisy speech.', languages: AUTO_ONLY },
			{ id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', blurb: 'Faster and cheaper, slightly lower accuracy.', languages: AUTO_ONLY },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
	deepgram: {
		label: 'Deepgram',
		defaultModel: 'nova-3',
		// Note: Flux (flux-general-en / flux-general-multi) is intentionally not
		// listed. It is streaming-only (wss /v2/listen) and Deepgram rejects it
		// on the pre-recorded POST /v1/listen endpoint this app uses.
		models: [
			{ id: 'nova-3', label: 'Nova 3', blurb: 'Flagship model, best accuracy. Default.', languages: NOVA3_LANGUAGES },
			{ id: 'nova-2', label: 'Nova 2', blurb: 'Previous generation. Fallback for languages/features Nova 3 lacks.', languages: NOVA2_LANGUAGES },
			{ id: 'nova-3-medical', label: 'Nova 3 Medical', blurb: 'Best for medical terminology. English only.', languages: ENGLISH_ONLY },
			{ id: 'nova-2-meeting', label: 'Nova 2 Meeting', blurb: 'Tuned for multi-speaker meetings. English only.', languages: ENGLISH_ONLY },
			{ id: 'nova-2-phonecall', label: 'Nova 2 Phone Call', blurb: 'Tuned for phone-call audio. English only.', languages: ENGLISH_ONLY },
			{ id: 'whisper-large', label: 'Whisper Large (via Deepgram)', blurb: 'OpenAI Whisper served by Deepgram. Stricter rate limits.', languages: WHISPER_LANGUAGES },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
	assemblyai: {
		label: 'AssemblyAI',
		defaultModel: 'universal-3-5-pro',
		models: [
			{ id: 'universal-3-5-pro', label: 'Universal 3.5 Pro', blurb: 'Flagship async model. Falls back to Universal 2 per request. Default.', languages: ASSEMBLYAI_U35P_LANGUAGES },
			{ id: 'universal-2', label: 'Universal 2', blurb: 'Covers ~99 languages. Fallback for unsupported languages.', languages: ASSEMBLYAI_U2_LANGUAGES },
		],
		needsAccountId: false,
		needsGatewayId: false,
	},
}

export function isProviderModel(provider: SttProviderId, model: string): boolean {
	return PROVIDERS[provider].models.some((option) => option.id === model)
}

export function resolveProviderModel(provider: SttProviderId, model: string | undefined): string {
	return model && isProviderModel(provider, model) ? model : PROVIDERS[provider].defaultModel
}

export function modelLanguages(provider: SttProviderId, model: string): string[] {
	return PROVIDERS[provider].models.find((option) => option.id === model)?.languages ?? []
}

// '' means auto-detect. Any code outside the model's list resolves to ''.
export function resolveLanguage(provider: SttProviderId, model: string, language: string | undefined): string {
	return language && modelLanguages(provider, model).includes(language) ? language : ''
}

export interface FlowSettings {
	provider: SttProviderId
	accountId: string
	gatewayId: string
	model: string
	language: string
	maxSeconds: number
}

const DEFAULTS: FlowSettings = {
	provider: 'cloudflare',
	accountId: '',
	gatewayId: 'flow',
	model: PROVIDERS.cloudflare.defaultModel,
	language: '',
	maxSeconds: 60,
}
export interface ProviderSetup {
	provider: SttProviderId
	accountId?: string
	gatewayId?: string
	model?: string
	language?: string
	token: string
}

export interface ProviderStatus {
	provider: SttProviderId
	model: string
	language: string
	configured: boolean
}

function settingsPath(): string {
	return path.join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): FlowSettings {
	try {
		const raw = fs.readFileSync(settingsPath(), 'utf8')
		const saved = JSON.parse(raw) as Partial<FlowSettings>
		const hasProvider = isProvider(saved.provider ?? '')
		const provider = hasProvider
			? (saved.provider as SttProviderId)
			: saved.accountId && loadProviderToken('cloudflare')
				? 'cloudflare'
				: detectedEnvironmentProvider()
		const model = hasProvider ? resolveProviderModel(provider, saved.model) : PROVIDERS[provider].defaultModel
		const language = hasProvider ? resolveLanguage(provider, model, saved.language) : ''
		return { ...DEFAULTS, ...saved, provider, model, language }
	} catch {
		const provider = detectedEnvironmentProvider()
		return { ...DEFAULTS, provider, model: PROVIDERS[provider].defaultModel }
	}
}

export function providerStatus(): ProviderStatus {
	const settings = loadSettings()
	const model = resolveProviderModel(settings.provider, settings.model || undefined)
	return {
		provider: settings.provider,
		model,
		language: resolveLanguage(settings.provider, model, settings.language || undefined),
		configured: isProviderConfigured(settings),
	}
}

export function isProviderConfigured(settings = loadSettings()): boolean {
	return Boolean(loadProviderToken(settings.provider)) && (settings.provider !== 'cloudflare' || Boolean(settings.accountId))
}

export function saveProviderSetup(setup: unknown): ProviderStatus {
	if (!setup || typeof setup !== 'object') throw new Error('Choose a provider and enter its API key.')
	const candidate = setup as Partial<ProviderSetup>
	if (!isProvider(candidate.provider ?? '')) {
		throw new Error('Choose a provider and enter its API key.')
	}
	const provider = candidate.provider as SttProviderId
	// An empty token keeps the already-saved key; only a non-empty one replaces it.
	const token = typeof candidate.token === 'string' ? candidate.token.trim() : ''
	if (!token && !loadProviderToken(provider)) {
		throw new Error('An API key is required — no key is saved for this provider yet.')
	}
	if (candidate.accountId !== undefined && typeof candidate.accountId !== 'string') throw new Error('Invalid Cloudflare account ID.')
	if (candidate.gatewayId !== undefined && typeof candidate.gatewayId !== 'string') throw new Error('Invalid Cloudflare gateway ID.')
	const definition = PROVIDERS[provider]
	const accountId = candidate.accountId?.trim() ?? ''
	if (definition.needsAccountId && !accountId) throw new Error('Cloudflare account ID is required.')
	const current = loadSettings()
	const model = resolveProviderModel(provider, typeof candidate.model === 'string' ? candidate.model : undefined)
	const next: FlowSettings = {
		...current,
		provider,
		accountId: definition.needsAccountId ? accountId : '',
		gatewayId: definition.needsGatewayId ? (candidate.gatewayId?.trim() || 'flow') : '',
		model,
		language: resolveLanguage(provider, model, typeof candidate.language === 'string' ? candidate.language : undefined),
	}
	if (token) saveProviderToken(provider, token)
	saveSettings(next)
	return providerStatus()
}

// Kept for existing callers and user installations created before multi-provider setup.
export function saveGatewayToken(token: string): void {
	saveProviderToken('cloudflare', token)
}

export function loadGatewayToken(): string {
	return loadProviderToken('cloudflare')
}

export function saveSettings(next: FlowSettings): void {
	fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
	fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
}
function isProvider(value: string): value is SttProviderId {
	return (STT_PROVIDERS as readonly string[]).includes(value)
}

function tokenPath(provider: SttProviderId): string {
	return path.join(app.getPath('userData'), `stt-token-${provider}.bin`)
}
function legacyGatewayTokenPath(): string {
	return path.join(app.getPath('userData'), 'gateway-token.bin')
}

function environmentToken(provider: SttProviderId): string {
	const names: Record<SttProviderId, string[]> = {
		cloudflare: ['CLOUDFLARE_AI_GATEWAY_TOKEN', 'CLOUDFLARE_API_TOKEN'],
		openrouter: ['OPENROUTER_API_KEY'],
		openai: ['OPENAI_API_KEY'],
		vercel: ['AI_GATEWAY_API_KEY'],
		deepgram: ['DEEPGRAM_API_KEY'],
		assemblyai: ['ASSEMBLYAI_API_KEY'],
	}
	return names[provider].map((name) => process.env[name] ?? '').find(Boolean) ?? ''
}
function detectedEnvironmentProvider(): SttProviderId {
	return STT_PROVIDERS.find((provider) => provider !== 'cloudflare' && Boolean(environmentToken(provider))) ?? 'cloudflare'
}

export function saveProviderToken(provider: SttProviderId, token: string): void {
	fs.mkdirSync(path.dirname(tokenPath(provider)), { recursive: true })
	if (safeStorage.isEncryptionAvailable()) {
		fs.writeFileSync(tokenPath(provider), safeStorage.encryptString(token))
	} else {
		fs.writeFileSync(tokenPath(provider), Buffer.from(`plain:${token}`))
	}
}

export function loadProviderToken(provider: SttProviderId): string {
	try {
		const buf = fs.readFileSync(tokenPath(provider))
		if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
		const s = buf.toString('utf8')
		return s.startsWith('plain:') ? s.slice(6) : ''
	} catch {
		if (provider === 'cloudflare') {
			try {
				const buf = fs.readFileSync(legacyGatewayTokenPath())
				if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
				const s = buf.toString('utf8')
				return s.startsWith('plain:') ? s.slice(6) : ''
			} catch {
				// Fall through to the environment-based legacy setup.
			}
		}
		return environmentToken(provider)
	}
}
