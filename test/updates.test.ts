import { describe, expect, it } from 'vitest'
import { isNewerVersion, parseVersion, pickAsset } from '../src/main/updates'

describe('parseVersion', () => {
	it('parses with and without a leading v', () => {
		expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
		expect(parseVersion('0.10.1')).toEqual([0, 10, 1])
	})

	it('rejects unparseable versions', () => {
		expect(() => parseVersion('beta')).toThrow(/Unparseable/)
	})
})

describe('isNewerVersion', () => {
	it('is false for equal and older versions', () => {
		expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
		expect(isNewerVersion('v0.1.9', '0.2.0')).toBe(false)
	})

	it('compares numerically, not lexically', () => {
		expect(isNewerVersion('v0.2.0', '0.1.9')).toBe(true)
		expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
		expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
		expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
	})
})

describe('pickAsset', () => {
	const assets = [
		{ name: 'flow-0.2.0.dmg.blockmap', browser_download_url: 'https://x/blockmap' },
		{ name: 'flow-0.2.0.dmg', browser_download_url: 'https://x/flow-0.2.0.dmg' },
		{ name: 'flow-0.2.0-arm64.dmg', browser_download_url: 'https://x/flow-0.2.0-arm64.dmg' },
		{ name: 'flow-0.2.0.zip', browser_download_url: 'https://x/flow-0.2.0.zip' },
	]

	it('picks the arm64 DMG on arm64', () => {
		expect(pickAsset(assets, 'arm64')).toBe('https://x/flow-0.2.0-arm64.dmg')
	})

	it('picks the plain DMG on x64, skipping the arm64 one', () => {
		expect(pickAsset(assets, 'x64')).toBe('https://x/flow-0.2.0.dmg')
	})

	it('returns null when no DMG exists', () => {
		expect(pickAsset([{ name: 'flow.zip', browser_download_url: 'https://x' }], 'arm64')).toBeNull()
	})
})
