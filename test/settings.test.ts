import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ userData: '/tmp/flow-settings-test' }))

vi.mock('electron', () => ({
	app: { getPath: () => hoisted.userData },
	safeStorage: { isEncryptionAvailable: () => false },
}))

import {
	DEFAULT_LLM_BASE_URL,
	DEFAULT_LLM_MODEL,
	isProviderConfigured,
	loadGatewayToken,
	loadProviderToken,
	loadSettings,
	providerStatus,
	resolveProviderSetup,
	saveGatewayToken,
	saveProviderSetup,
	saveProviderToken,
	saveSettings,
} from '../src/main/settings'

const TOKEN_ENV_KEYS = [
	'CLOUDFLARE_AI_GATEWAY_TOKEN',
	'CLOUDFLARE_API_TOKEN',
	'OPENROUTER_API_KEY',
	'OPENAI_API_KEY',
	'AI_GATEWAY_API_KEY',
	'DEEPGRAM_API_KEY',
	'ASSEMBLYAI_API_KEY',
	'LLM_API_KEY',
]

let savedEnv: Record<string, string | undefined> = {}

function settingsFile(): string {
	return path.join(hoisted.userData, 'settings.json')
}

function writeSettingsFile(value: unknown): void {
	fs.mkdirSync(hoisted.userData, { recursive: true })
	fs.writeFileSync(settingsFile(), typeof value === 'string' ? value : JSON.stringify(value))
}

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

describe('resolveProviderSetup', () => {
	it('rejects a missing or malformed setup', () => {
		expect(() => resolveProviderSetup(null)).toThrow(/choose a provider/i)
		expect(() => resolveProviderSetup(undefined)).toThrow(/choose a provider/i)
		expect(() => resolveProviderSetup('openai')).toThrow(/choose a provider/i)
		expect(() => resolveProviderSetup({})).toThrow(/choose a provider/i)
		expect(() => resolveProviderSetup({ provider: 'bogus', token: 't' })).toThrow(/choose a provider/i)
	})

	it('requires an API key when none is saved for the provider', () => {
		expect(() => resolveProviderSetup({ provider: 'openai', token: '' })).toThrow(/API key/i)
		expect(() => resolveProviderSetup({ provider: 'openai', token: '   ' })).toThrow(/API key/i)
		expect(() => resolveProviderSetup({ provider: 'openai' })).toThrow(/API key/i)
	})

	it('keeps the saved key when the token field is blank', () => {
		saveProviderToken('openai', 'saved-key')
		const resolved = resolveProviderSetup({ provider: 'openai', token: '' })
		expect(resolved.token).toBe('saved-key')
		expect(resolved.newToken).toBe('')
	})

	it('requires the Cloudflare account id and defaults the gateway id', () => {
		expect(() => resolveProviderSetup({ provider: 'cloudflare', token: 't' })).toThrow(/account ID/i)
		const resolved = resolveProviderSetup({ provider: 'cloudflare', accountId: ' acct ', token: 't' })
		expect(resolved.settings.accountId).toBe('acct')
		expect(resolved.settings.gatewayId).toBe('flow')
	})

	it('rejects non-string Cloudflare fields', () => {
		expect(() => resolveProviderSetup({ provider: 'cloudflare', accountId: 42, token: 't' })).toThrow(/account ID/i)
		expect(() => resolveProviderSetup({ provider: 'cloudflare', accountId: 'a', gatewayId: 42, token: 't' })).toThrow(/gateway ID/i)
	})

	it('clears Cloudflare-only fields for other providers', () => {
		writeSettingsFile({ provider: 'cloudflare', accountId: 'old', gatewayId: 'old-gw' })
		const resolved = resolveProviderSetup({ provider: 'openai', accountId: 'ignored', gatewayId: 'ignored', token: 't' })
		expect(resolved.settings.accountId).toBe('')
		expect(resolved.settings.gatewayId).toBe('')
	})

	it('resolves unknown models and languages back to safe defaults', () => {
		const resolved = resolveProviderSetup({ provider: 'openai', model: 'not-a-model', language: 'xx', token: 't' })
		expect(resolved.settings.model).toBe('gpt-4o-mini-transcribe')
		expect(resolved.settings.language).toBe('')
		const good = resolveProviderSetup({ provider: 'deepgram', model: 'nova-3', language: 'es', token: 't' })
		expect(good.settings.model).toBe('nova-3')
		expect(good.settings.language).toBe('es')
	})
})

describe('loadSettings', () => {
	it('returns defaults when no file exists', () => {
		const settings = loadSettings()
		expect(settings.provider).toBe('cloudflare')
		expect(settings.model).toBe('@cf/openai/whisper-large-v3-turbo')
		expect(settings.language).toBe('')
		expect(settings.maxSeconds).toBe(60)
		expect(settings.muteSystemAudio).toBe(false)
		expect(settings.llmBaseUrl).toBe(DEFAULT_LLM_BASE_URL)
		expect(settings.llmModel).toBe(DEFAULT_LLM_MODEL)
	})

	it('returns defaults for a corrupt or non-object file', () => {
		writeSettingsFile('{not json')
		expect(loadSettings().provider).toBe('cloudflare')
		writeSettingsFile('null')
		expect(loadSettings().provider).toBe('cloudflare')
	})

	it('round-trips a saved provider, model, and language', () => {
		saveSettings({
			provider: 'deepgram',
			accountId: '',
			gatewayId: '',
			model: 'nova-3',
			language: 'es',
			maxSeconds: 90,
			muteSystemAudio: true,
			llmBaseUrl: 'https://llm.test/v1',
			llmModel: 'big',
		})
		const settings = loadSettings()
		expect(settings.provider).toBe('deepgram')
		expect(settings.model).toBe('nova-3')
		expect(settings.language).toBe('es')
		expect(settings.maxSeconds).toBe(90)
		expect(settings.muteSystemAudio).toBe(true)
	})

	it('falls back to the provider default for a stale saved model or language', () => {
		writeSettingsFile({ provider: 'openai', model: 'nova-3', language: 'multi' })
		const settings = loadSettings()
		expect(settings.model).toBe('gpt-4o-mini-transcribe')
		expect(settings.language).toBe('')
	})

	it('detects the provider from environment keys when none is saved', () => {
		process.env.OPENAI_API_KEY = 'env-key'
		const settings = loadSettings()
		expect(settings.provider).toBe('openai')
		expect(settings.model).toBe('gpt-4o-mini-transcribe')
	})

	it('prefers the earliest env-configured provider and never env-detects cloudflare', () => {
		process.env.DEEPGRAM_API_KEY = 'd'
		process.env.OPENROUTER_API_KEY = 'o'
		expect(loadSettings().provider).toBe('openrouter')
		// Cloudflare env tokens exist but cloudflare is excluded from env detection.
		delete process.env.OPENROUTER_API_KEY
		delete process.env.DEEPGRAM_API_KEY
		process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'cf'
		expect(loadSettings().provider).toBe('cloudflare')
	})

	it('keeps a legacy cloudflare install working via account id plus saved token', () => {
		writeSettingsFile({ provider: 'bogus', accountId: 'acct' })
		saveProviderToken('cloudflare', 'cf-key')
		expect(loadSettings().provider).toBe('cloudflare')
	})

	it('clamps maxSeconds to a positive finite integer', () => {
		writeSettingsFile({ provider: 'openai', maxSeconds: -5 })
		expect(loadSettings().maxSeconds).toBe(60)
		writeSettingsFile({ provider: 'openai', maxSeconds: 'abc' })
		expect(loadSettings().maxSeconds).toBe(60)
		writeSettingsFile({ provider: 'openai', maxSeconds: 0 })
		expect(loadSettings().maxSeconds).toBe(60)
		writeSettingsFile({ provider: 'openai', maxSeconds: 30.9 })
		expect(loadSettings().maxSeconds).toBe(30)
	})

	it('treats non-boolean muteSystemAudio as off', () => {
		writeSettingsFile({ provider: 'openai', muteSystemAudio: 'yes' })
		expect(loadSettings().muteSystemAudio).toBe(false)
	})
})

describe('provider tokens', () => {
	it('stores plaintext with the plain: prefix when encryption is unavailable', () => {
		saveProviderToken('openai', 'tok-1')
		const raw = fs.readFileSync(path.join(hoisted.userData, 'stt-token-openai.bin'), 'utf8')
		expect(raw).toBe('plain:tok-1')
		expect(loadProviderToken('openai')).toBe('tok-1')
	})

	it('falls back to the environment key per provider', () => {
		process.env.OPENROUTER_API_KEY = 'env-or'
		expect(loadProviderToken('openrouter')).toBe('env-or')
		expect(loadProviderToken('openai')).toBe('')
	})

	it('reads the pre-multi-provider gateway-token.bin for cloudflare', () => {
		fs.mkdirSync(hoisted.userData, { recursive: true })
		fs.writeFileSync(path.join(hoisted.userData, 'gateway-token.bin'), Buffer.from('plain:legacy-tok'))
		expect(loadProviderToken('cloudflare')).toBe('legacy-tok')
	})

	it('prefers the per-provider token over the legacy file', () => {
		fs.mkdirSync(hoisted.userData, { recursive: true })
		fs.writeFileSync(path.join(hoisted.userData, 'gateway-token.bin'), Buffer.from('plain:legacy-tok'))
		saveProviderToken('cloudflare', 'new-tok')
		expect(loadProviderToken('cloudflare')).toBe('new-tok')
	})

	it('keeps the legacy saveGatewayToken/loadGatewayToken shims working', () => {
		saveGatewayToken('gw-tok')
		expect(loadGatewayToken()).toBe('gw-tok')
		expect(loadProviderToken('cloudflare')).toBe('gw-tok')
	})
})

describe('isProviderConfigured / providerStatus', () => {
	it('requires a saved key plus the Cloudflare account id', () => {
		saveProviderToken('cloudflare', 'cf-key')
		expect(isProviderConfigured()).toBe(false)
		saveProviderSetup({ provider: 'cloudflare', accountId: 'acct', token: '' })
		expect(isProviderConfigured()).toBe(true)
	})

	it('only needs a key for non-Cloudflare providers', () => {
		saveProviderSetup({ provider: 'openai', token: 'k' })
		expect(isProviderConfigured()).toBe(true)
	})

	it('reports provider, resolved model/language, and configured flag', () => {
		saveProviderSetup({ provider: 'deepgram', model: 'nova-3', language: 'es', token: 'k' })
		expect(providerStatus()).toEqual({ provider: 'deepgram', model: 'nova-3', language: 'es', configured: true })
	})
})
