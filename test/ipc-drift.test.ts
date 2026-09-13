import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_VISIBLE_MS, IPC_CHANNELS } from '../src/ipc'

// src/preload.ts cannot import ./ipc (sandboxed preloads cannot resolve
// relative requires) and src/renderer.ts loads as a plain script, so both
// duplicate constants with "keep in sync" comments. This file is the sync.
function source(name: string): string {
	return readFileSync(join(__dirname, '..', 'src', name), 'utf8')
}

describe('preload channel map', () => {
	it('inlines every channel from src/ipc.ts with the same name and value', () => {
		const preload = source('preload.ts')
		for (const [key, value] of Object.entries(IPC_CHANNELS)) {
			expect(preload).toContain(`${key}: '${value}'`)
		}
	})

	it('inlines no extra channels beyond src/ipc.ts', () => {
		const preload = source('preload.ts')
		const block = preload.match(/const IPC_CHANNELS = \{([^}]*)\} as const/)
		expect(block).not.toBeNull()
		const inlined = new Set(Array.from(block?.[1].matchAll(/(\w+): '/g) ?? [], (match) => match[1]))
		expect(inlined).toEqual(new Set(Object.keys(IPC_CHANNELS)))
	})
})

describe('renderer timing constants', () => {
	it('duplicates ERROR_VISIBLE_MS with the same value', () => {
		const renderer = source('renderer.ts')
		const match = renderer.match(/ERROR_VISIBLE_MS = (\d+)/)
		expect(match).not.toBeNull()
		expect(Number(match?.[1])).toBe(ERROR_VISIBLE_MS)
	})
})
