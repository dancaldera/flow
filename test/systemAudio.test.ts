import { describe, expect, it } from 'vitest'
import { parseOutputMuted } from '../src/main/systemAudio'

describe('parseOutputMuted', () => {
	it('detects a muted output', () => {
		expect(parseOutputMuted('true')).toBe(true)
	})

	it('detects an unmuted output', () => {
		expect(parseOutputMuted('false')).toBe(false)
	})

	it('treats empty output as unmuted', () => {
		expect(parseOutputMuted('')).toBe(false)
	})
})
