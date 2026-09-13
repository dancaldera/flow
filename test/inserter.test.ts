import { execFile } from 'node:child_process'
import { clipboard } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ clip: 'previous-clip' }))

vi.mock('electron', () => ({
	clipboard: {
		readText: vi.fn(() => hoisted.clip),
		writeText: vi.fn((text: string) => {
			hoisted.clip = text
		}),
	},
}))

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { insertTextAtCursor } from '../src/main/inserter'

const execFileMock = vi.mocked(execFile)
const readText = vi.mocked(clipboard.readText)
const writeText = vi.mocked(clipboard.writeText)

/** Runs every osascript call successfully. */
function osascriptOK(): void {
	execFileMock.mockImplementation((_cmd, _args, cb) => {
		;(cb as (e: Error | null) => void)(null)
		return undefined as never
	})
}

function lastWrite(): string {
	return writeText.mock.calls[writeText.mock.calls.length - 1]?.[0] as string
}

beforeEach(() => {
	vi.useFakeTimers()
	hoisted.clip = 'previous-clip'
	execFileMock.mockReset()
	readText.mockClear()
	writeText.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('insertTextAtCursor', () => {
	it('does nothing for empty text', async () => {
		await expect(insertTextAtCursor('')).resolves.toBe('pasted')
		expect(execFileMock).not.toHaveBeenCalled()
		expect(writeText).not.toHaveBeenCalled()
	})

	it('writes the text, pastes with Cmd+V, and restores the old clipboard', async () => {
		osascriptOK()
		const done = insertTextAtCursor('hello world')
		await vi.advanceTimersByTimeAsync(120)
		await expect(done).resolves.toBe('pasted')
		expect(execFileMock).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('keystroke "v" using command down')], expect.any(Function))
		expect(lastWrite()).toBe('hello world')
		// The restore only rewrites when the clipboard still holds our text —
		// a clipboard the user replaced mid-paste is left alone.
		await vi.advanceTimersByTimeAsync(400)
		expect(lastWrite()).toBe('previous-clip')
	})

	it('leaves a clipboard the user changed during the paste alone', async () => {
		osascriptOK()
		const done = insertTextAtCursor('hello world')
		await vi.advanceTimersByTimeAsync(120)
		await done
		hoisted.clip = 'user copied something else'
		await vi.advanceTimersByTimeAsync(400)
		expect(lastWrite()).toBe('hello world')
		expect(clipboard.readText()).toBe('user copied something else')
	})

	it('falls back to typing when the paste keystroke fails', async () => {
		execFileMock
			.mockImplementationOnce((_cmd, _args, cb) => {
				;(cb as (e: Error | null) => void)(new Error('no assistive access'))
				return undefined as never
			})
			.mockImplementation((_cmd, _args, cb) => {
				;(cb as (e: Error | null) => void)(null)
				return undefined as never
			})
		const done = insertTextAtCursor('hello')
		await vi.advanceTimersByTimeAsync(0)
		await expect(done).resolves.toBe('typed')
		expect(execFileMock).toHaveBeenLastCalledWith('osascript', ['-e', expect.stringContaining('keystroke "hello"')], expect.any(Function))
	})

	it('propagates the failure when typing also fails', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) => {
			;(cb as (e: Error | null) => void)(new Error('denied'))
			return undefined as never
		})
		const done = insertTextAtCursor('hello')
		done.catch(() => {})
		await vi.advanceTimersByTimeAsync(0)
		await expect(done).rejects.toThrow('denied')
	})
})
