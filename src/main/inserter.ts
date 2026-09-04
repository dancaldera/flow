import { execFile } from 'node:child_process'
import { clipboard } from 'electron'

function runosascript(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('osascript', args, (error) => (error ? reject(error) : resolve()))
	})
}

export async function insertTextAtCursor(text: string): Promise<'pasted' | 'typed'> {
	if (!text) return 'pasted'
	const previous = clipboard.readText()
	try {
		clipboard.writeText(text)
		// Paste into the previously focused app.
		await runosascript(['-e', 'tell application "System Events" to keystroke "v" using command down'])
		await new Promise((r) => setTimeout(r, 120))
		return 'pasted'
	} catch {
		// Fallback: type char-by-char (slow but works in secure fields).
		await runosascript(['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`])
		return 'typed'
	} finally {
		// Restore what was there before, unless the user copied during our paste.
		setTimeout(() => {
			try {
				if (clipboard.readText() === text) clipboard.writeText(previous)
			} catch {
				// ignore restore errors
			}
		}, 400)
	}
}
