import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ userData: '/tmp/flow-jev-test' }))

vi.mock('electron', () => ({
	app: { getPath: () => hoisted.userData },
	safeStorage: { isEncryptionAvailable: () => false },
}))

import { isJevConfigured, jevStatus, loadJevToken, saveJevSetup } from '../src/main/settings'
import { CHOICE_THRESHOLD, COMMANDS, COMMAND_THRESHOLD, decideCommand, jevEndpoint, pickCommand, testJev } from '../src/services/jev'

let savedTypeSafe: string | undefined
let savedOpenRouter: string | undefined

beforeEach(() => {
	savedTypeSafe = process.env.TYPESAFE_API_KEY
	savedOpenRouter = process.env.OPENROUTER_API_KEY
	delete process.env.TYPESAFE_API_KEY
	delete process.env.OPENROUTER_API_KEY
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
	vi.unstubAllGlobals()
})

afterEach(() => {
	if (savedTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY
	else process.env.TYPESAFE_API_KEY = savedTypeSafe
	if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY
	else process.env.OPENROUTER_API_KEY = savedOpenRouter
	fs.rmSync(hoisted.userData, { recursive: true, force: true })
	vi.unstubAllGlobals()
})

describe('pickCommand', () => {
	it('returns the command id when both thresholds are met', () => {
		expect(pickCommand({ is_command: { noul: COMMAND_THRESHOLD }, command: { choice: 'mute', confidence: CHOICE_THRESHOLD } })).toBe('mute')
	})

	it('returns null when the noul is below threshold', () => {
		expect(pickCommand({ is_command: { noul: COMMAND_THRESHOLD - 0.1 }, command: { choice: 'mute', confidence: 0.9 } })).toBeNull()
	})

	it("returns null when the choice is 'dictate'", () => {
		expect(pickCommand({ is_command: { noul: 0.95 }, command: { choice: 'dictate', confidence: 0.9 } })).toBeNull()
	})

	it('returns null when confidence is low', () => {
		expect(pickCommand({ is_command: { noul: 0.95 }, command: { choice: 'mute', confidence: CHOICE_THRESHOLD - 0.1 } })).toBeNull()
	})

	it('returns null when the choice is unknown', () => {
		expect(pickCommand({ is_command: { noul: 0.95 }, command: { choice: 'launch_rockets', confidence: 0.9 } })).toBeNull()
	})
})

describe('jevEndpoint', () => {
	it('routes sk-or- keys to OpenRouter', () => {
		expect(jevEndpoint('sk-or-v1-abc')).toEqual({ url: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' })
	})

	it('routes other keys to TypeSafe direct', () => {
		expect(jevEndpoint('ts_abc')).toEqual({ url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' })
	})
})

describe('decideCommand', () => {
	it('posts the transcript to Jev and returns a confident command', async () => {
		process.env.TYPESAFE_API_KEY = 'ts_test'
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ answers: { is_command: { noul: 0.99 }, command: { choice: 'mute', confidence: 0.9 } } }), { status: 200 }),
		)
		vi.stubGlobal('fetch', fetchMock)
		expect(await decideCommand('mute the sound')).toBe('mute')
		const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://api.typesafe.ai/v1/systemone')
		expect((request.headers as Record<string, string>).Authorization).toBe('Bearer ts_test')
		const body = JSON.parse(String(request.body)) as { model: string; state: string; questions: Record<string, { type: string }> }
		expect(body.model).toBe('jev-latest')
		expect(body.state).toBe('mute the sound')
		expect(body.questions.is_command.type).toBe('noul')
		expect(body.questions.command.type).toBe('choice')
	})

	it('returns null instead of throwing when fetch rejects', async () => {
		process.env.TYPESAFE_API_KEY = 'ts_test'
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
		expect(await decideCommand('mute')).toBeNull()
	})

	it('skips the call entirely without a key', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect(await decideCommand('mute')).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('testJev', () => {
	function noulResponse(noul: number, status = 200): Response {
		return new Response(JSON.stringify({ answers: { is_command: { noul } } }), { status })
	}

	it('resolves with the typesafe provider for a direct key', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noulResponse(0.9)))
		await expect(testJev('ts_x')).resolves.toEqual({ provider: 'typesafe' })
	})

	it('resolves with the openrouter provider for an sk-or- key', async () => {
		const fetchMock = vi.fn().mockResolvedValue(noulResponse(0.9))
		vi.stubGlobal('fetch', fetchMock)
		await expect(testJev('sk-or-x')).resolves.toEqual({ provider: 'openrouter' })
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions')
	})

	it('rejects on an auth failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
		await expect(testJev('ts_bad')).rejects.toThrow(/authentication/i)
	})

	it('rejects when fetch fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
		await expect(testJev('ts_x')).rejects.toThrow(/unreachable/i)
	})
})

describe('jev settings', () => {
	it('saves a key and reports configured with the typesafe provider', () => {
		const status = saveJevSetup({ token: 'k' })
		expect(isJevConfigured()).toBe(true)
		expect(loadJevToken()).toBe('k')
		expect(status).toEqual({ configured: true, provider: 'typesafe' })
	})

	it('reports the openrouter provider for an sk-or- key', () => {
		expect(saveJevSetup({ token: 'sk-or-v1-abc' })).toEqual({ configured: true, provider: 'openrouter' })
	})

	it('throws when nothing is saved and the token is empty', () => {
		expect(() => saveJevSetup({ token: '' })).toThrow(/required/)
	})

	it('keeps the saved key when the token is blank', () => {
		saveJevSetup({ token: 'first' })
		saveJevSetup({ token: '  ' })
		expect(loadJevToken()).toBe('first')
	})
})

describe('COMMANDS', () => {
	it('every entry has a non-empty blurb and script', () => {
		for (const command of Object.values(COMMANDS)) {
			expect(command.blurb.length).toBeGreaterThan(0)
			expect(command.script.length).toBeGreaterThan(0)
		}
	})
})
