import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
export const STT_PROVIDERS = ['cloudflare', 'openrouter', 'openai', 'vercel', 'deepgram', 'assemblyai'] as const
export type SttProviderId = (typeof STT_PROVIDERS)[number]

export interface ProviderDefinition {
	label: string
	defaultModel: string
	needsAccountId: boolean
	needsGatewayId: boolean
}

export const PROVIDERS: Record<SttProviderId, ProviderDefinition> = {
	cloudflare: {
		label: 'Cloudflare AI Gateway',
		defaultModel: '@cf/openai/whisper-large-v3-turbo',
		needsAccountId: true,
		needsGatewayId: true,
	},
	openrouter: { label: 'OpenRouter', defaultModel: 'openai/whisper-1', needsAccountId: false, needsGatewayId: false },
	openai: { label: 'OpenAI', defaultModel: 'gpt-4o-mini-transcribe', needsAccountId: false, needsGatewayId: false },
	vercel: { label: 'Vercel AI Gateway', defaultModel: 'openai/whisper-1', needsAccountId: false, needsGatewayId: false },
	deepgram: { label: 'Deepgram', defaultModel: 'nova-3', needsAccountId: false, needsGatewayId: false },
	assemblyai: {
		label: 'AssemblyAI',
		defaultModel: 'universal-3-5-pro',
		needsAccountId: false,
		needsGatewayId: false,
	},
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
	token: string
}

export interface ProviderStatus {
	provider: SttProviderId
	model: string
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
		return { ...DEFAULTS, ...saved, provider, model: hasProvider ? (saved.model ?? PROVIDERS[provider].defaultModel) : PROVIDERS[provider].defaultModel }
	} catch {
		const provider = detectedEnvironmentProvider()
		return { ...DEFAULTS, provider, model: PROVIDERS[provider].defaultModel }
	}
}

export function providerStatus(): ProviderStatus {
	const settings = loadSettings()
	return {
		provider: settings.provider,
		model: settings.model || PROVIDERS[settings.provider].defaultModel,
		configured: isProviderConfigured(settings),
	}
}

export function isProviderConfigured(settings = loadSettings()): boolean {
	return Boolean(loadProviderToken(settings.provider)) && (settings.provider !== 'cloudflare' || Boolean(settings.accountId))
}

export function saveProviderSetup(setup: unknown): ProviderStatus {
	if (!setup || typeof setup !== 'object') throw new Error('Choose a provider and enter its API key.')
	const candidate = setup as Partial<ProviderSetup>
	if (!isProvider(candidate.provider ?? '') || typeof candidate.token !== 'string' || !candidate.token.trim()) {
		throw new Error('Choose a provider and enter its API key.')
	}
	if (candidate.accountId !== undefined && typeof candidate.accountId !== 'string') throw new Error('Invalid Cloudflare account ID.')
	if (candidate.gatewayId !== undefined && typeof candidate.gatewayId !== 'string') throw new Error('Invalid Cloudflare gateway ID.')
	const provider = candidate.provider as SttProviderId
	const definition = PROVIDERS[provider]
	const accountId = candidate.accountId?.trim() ?? ''
	if (definition.needsAccountId && !accountId) throw new Error('Cloudflare account ID is required.')
	const current = loadSettings()
	const next: FlowSettings = {
		...current,
		provider,
		accountId: definition.needsAccountId ? accountId : '',
		gatewayId: definition.needsGatewayId ? (candidate.gatewayId?.trim() || 'flow') : '',
		model: definition.defaultModel,
	}
	saveProviderToken(provider, candidate.token.trim())
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
