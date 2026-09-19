import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { loadJevToken } from '../main/settings'

// script = AppleScript run via osascript -e; helper = committed swift binary
// under swift/ — preferred when present, script is the fallback.
type Command = { blurb: string; script?: string; helper?: string }

function keys(combo: string): string {
	return `tell application "System Events" to ${combo}`
}

export const COMMANDS: Record<string, Command> = {
	// System basics
	lock_screen: { blurb: 'Lock the screen', helper: 'flow-lock', script: keys('keystroke "q" using {control down, command down}') },
	sleep: { blurb: 'Put the computer to sleep', script: 'tell application "System Events" to sleep' },
	mute: { blurb: 'Mute audio output', script: 'set volume with output muted' },
	unmute: { blurb: 'Unmute audio output', script: 'set volume without output muted' },
	volume_up: { blurb: 'Raise the volume', script: 'set volume output volume ((output volume of (get volume settings)) + 10)' },
	volume_down: { blurb: 'Lower the volume', script: 'set volume output volume ((output volume of (get volume settings)) - 10)' },
	screenshot: { blurb: 'Take a screenshot', script: keys('keystroke "3" using {shift down, command down}') },
	empty_trash: { blurb: 'Empty the Trash', script: 'tell application "Finder" to empty trash' },
	open_finder: { blurb: 'Open Finder', script: 'tell application "Finder" to activate' },
	open_terminal: { blurb: 'Open Terminal', script: 'tell application "Terminal" to activate' },
	open_browser: { blurb: 'Open the web browser', script: 'tell application "Safari" to activate' },
	// Text edits (frontmost app)
	undo: { blurb: 'Undo the last action', script: keys('keystroke "z" using {command down}') },
	redo: { blurb: 'Redo the last undone action', script: keys('keystroke "z" using {shift down, command down}') },
	select_all: { blurb: 'Select all text', script: keys('keystroke "a" using {command down}') },
	copy: { blurb: 'Copy the selection', script: keys('keystroke "c" using {command down}') },
	cut: { blurb: 'Cut the selection', script: keys('keystroke "x" using {command down}') },
	paste: { blurb: 'Paste the clipboard', script: keys('keystroke "v" using {command down}') },
	new_line: { blurb: 'Insert a new line', script: keys('key code 36') },
	delete_word: { blurb: 'Delete the previous word', script: keys('key code 51 using {option down}') },
}

const CHOICE_CRITERIA: Record<string, string | null> = Object.fromEntries([
	...Object.entries(COMMANDS).map(([id, command]) => [id, command.blurb] as const),
	['dictate', 'Any sentence or prose to be typed as text, even if it mentions copying, pasting, opening or undoing something'],
])

export const COMMAND_THRESHOLD = 0.7 // noul is_command
export const CHOICE_THRESHOLD = 0.8 // choice confidence

export type JevAnswers = { is_command?: { noul?: number }; command?: { choice?: string; confidence?: number } }

/** Pure: command id to run, or null → paste as dictation. */
export function pickCommand(answers: JevAnswers): string | null {
	const noul = answers.is_command?.noul ?? 0
	const choice = answers.command?.choice ?? ''
	const confidence = answers.command?.confidence ?? 0
	if (noul < COMMAND_THRESHOLD) return null
	if (!(choice in COMMANDS)) return null
	if (confidence < CHOICE_THRESHOLD) return null
	return choice
}

export function jevEndpoint(key: string): { url: string; model: string } {
	return key.startsWith('sk-or-')
		? { url: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' }
		: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }
}

export function jevKey(): string {
	return loadJevToken()
}

const MAX_COMMAND_CHARS = 200

async function askJev(key: string, state: string, questions: Record<string, object>): Promise<JevAnswers> {
	const { url, model } = jevEndpoint(key)
	let response: Response
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, state, questions }),
			signal: AbortSignal.timeout(4000),
		})
	} catch (error) {
		throw new Error(`Jev unreachable: ${error instanceof Error ? error.message : String(error)}`)
	}
	const data = (await response.json().catch(() => ({}))) as { answers?: JevAnswers; error?: { message?: string } | string; message?: string }
	if (response.status === 401 || response.status === 403) throw new Error('Jev authentication failed.')
	if (!response.ok) {
		const message = typeof data.error === 'string' ? data.error : (data.error?.message ?? data.message ?? response.statusText)
		throw new Error(`Jev ${response.status}: ${message}`)
	}
	return data.answers ?? {}
}

/** Null when no key, on any error, or when Jev says it's dictation. Never throws. */
export async function decideCommand(transcript: string): Promise<string | null> {
	try {
		const key = jevKey()
		const text = transcript.trim()
		if (!key || !text || text.length > MAX_COMMAND_CHARS) return null
		const answers = await askJev(key, text, {
			is_command: {
				type: 'noul',
				instructions:
					'The user is dictating into a computer. Is this a short spoken command telling the computer to do something right now (like "mute", "undo", "new line", "open terminal"), rather than words they want typed out as text?',
				criteria: {
					true: 'A brief imperative voice command aimed at the computer itself, including editing shortcuts such as new line, delete word, select all',
					false: 'A sentence, message, note or any prose meant to be typed, even if it mentions actions like copying, undoing or opening',
				},
			},
			command: {
				type: 'choice',
				instructions: 'Which action does the user want?',
				criteria: CHOICE_CRITERIA,
			},
		})
		return pickCommand(answers)
	} catch (error) {
		console.log(`[flow] jev failed: ${error instanceof Error ? error.message : error}`)
		return null
	}
}

export async function testJev(token: string): Promise<{ provider: 'openrouter' | 'typesafe' }> {
	const answers = await askJev(token, 'mute', {
		is_command: { type: 'noul', instructions: 'Is this a command?' },
	})
	if (typeof answers.is_command?.noul !== 'number') throw new Error('Jev returned no decision.')
	return { provider: token.startsWith('sk-or-') ? 'openrouter' : 'typesafe' }
}

function helperPath(name: string): string {
	// Same unpack rule as fnHelperPath in src/main/permissions.ts: child
	// processes cannot execute from inside the asar archive.
	return path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'swift', name)
}

export function runCommand(id: string): Promise<void> {
	const command = COMMANDS[id]
	if (!command) return Promise.resolve()
	const helper = command.helper ? helperPath(command.helper) : ''
	return new Promise((resolve, reject) => {
		const callback = (error: Error | null) => (error ? reject(error) : resolve())
		if (helper && fs.existsSync(helper)) execFile(helper, [], callback)
		else if (command.script) execFile('osascript', ['-e', command.script], callback)
		else resolve()
	})
}
