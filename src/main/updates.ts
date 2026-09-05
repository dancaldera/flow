import { app, dialog, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The repo is public: update checks hit the GitHub API unauthenticated.
export const GITHUB_REPO = 'dancaldera/flow'

export type ReleaseInfo = {
	tag: string
	version: string
	dmgUrl: string | null
	zipUrl: string | null
}

/** Parses "v1.2.3" / "1.2.3" into [major, minor, patch]. */
export function parseVersion(v: string): [number, number, number] {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
	if (!m) throw new Error(`Unparseable version: ${v}`)
	return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** True when candidate > current (semver, three components). */
export function isNewerVersion(candidate: string, current: string): boolean {
	const c = parseVersion(candidate)
	const cur = parseVersion(current)
	return c[0] !== cur[0] ? c[0] > cur[0] : c[1] !== cur[1] ? c[1] > cur[1] : c[2] > cur[2]
}

/** Picks the release asset matching this machine's architecture. */
export function pickAsset(
	assets: Array<{ name: string; browser_download_url: string }>,
	arch: string,
	ext: 'dmg' | 'zip' = 'dmg',
): string | null {
	const files = assets.filter((a) => a.name.toLowerCase().endsWith(`.${ext}`))
	const match = files.find((a) =>
		arch === 'arm64' ? a.name.toLowerCase().includes('-arm64') : !a.name.toLowerCase().includes('arm64'),
	)
	return match?.browser_download_url ?? null
}
/** Fetches the latest published release; null when none has a mac installer. */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo | null> {
	const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
		headers: { Accept: 'application/vnd.github+json' },
	})
	if (res.status === 404) return null // repo has no published releases yet
	if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
	const data = (await res.json()) as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> }
	const tag = data.tag_name
	if (!tag) throw new Error('GitHub API response has no tag_name')
	const dmgUrl = pickAsset(data.assets ?? [], process.arch, 'dmg')
	const zipUrl = pickAsset(data.assets ?? [], process.arch, 'zip')
	if (!dmgUrl && !zipUrl) return null
	return { tag, version: tag.replace(/^v/, ''), dmgUrl, zipUrl }
}

/** Interactive tray-menu flow: compare, confirm, download, open the installer. */
export async function checkForUpdates(onProgress?: (pct: number) => void): Promise<void> {
	let release: ReleaseInfo | null
	try {
		release = await fetchLatestRelease()
	} catch (error) {
		void dialog.showMessageBox({
			type: 'warning',
			message: 'Could not check for updates',
			detail: error instanceof Error ? error.message : String(error),
		})
		return
	}
	if (!release) {
		void dialog.showMessageBox({
			type: 'info',
			message: 'No installer found',
			detail: `No published release with a macOS installer exists in ${GITHUB_REPO}.`,
		})
		return
	}
	if (!isNewerVersion(release.version, app.getVersion())) {
		void dialog.showMessageBox({
			type: 'info',
			message: 'Flow is up to date',
			detail: `You are running ${app.getVersion()}; the latest release is ${release.version}.`,
		})
		return
	}
	// Auto-install path: app lives in /Applications and a zip asset exists.
	// A detached script swaps the bundle after this process exits, then relaunches.
	const appBundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..')
	if (appBundle.startsWith('/Applications/') && release.zipUrl) {
		const { response } = await dialog.showMessageBox({
			type: 'question',
			message: `Flow ${release.version} is available`,
			detail: `You are running ${app.getVersion()}. Download and install automatically? Flow will close and reopen.`,
			buttons: ['Install and restart', 'Cancel'],
			defaultId: 0,
			cancelId: 1,
		})
		if (response !== 0) return
		await installFromZip(release.zipUrl, appBundle, onProgress)
		return
	}
	// Fallback (dev build or no zip asset): download the DMG and open it.
	if (!release.dmgUrl) return
	const { response } = await dialog.showMessageBox({
		type: 'question',
		message: `Flow ${release.version} is available`,
		detail: `You are running ${app.getVersion()}. Download the installer and open it to reinstall?`,
		buttons: ['Download', 'Cancel'],
		defaultId: 0,
		cancelId: 1,
	})
	if (response !== 0) return
	try {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-update-'))
		const dmgPath = await downloadFile(release.dmgUrl, path.join(tmp, path.basename(new URL(release.dmgUrl).pathname)), onProgress)
		await dialog.showMessageBox({
			type: 'info',
			message: 'Installer downloaded',
			detail: `Opening ${path.basename(dmgPath)} — drag Flow into Applications to reinstall, then relaunch Flow.`,
		})
		await shell.openPath(dmgPath)
	} catch (error) {
		void dialog.showMessageBox({
			type: 'warning',
			message: 'Download failed',
			detail: error instanceof Error ? error.message : String(error),
		})
	}
}

/** Streams url to dest, reporting percent downloaded. */
async function downloadFile(url: string, dest: string, onProgress?: (pct: number) => void): Promise<string> {
	const res = await fetch(url)
	if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
	const total = Number(res.headers.get('content-length') ?? 0)
	const out = fs.createWriteStream(dest)
	const reader = res.body.getReader()
	let received = 0
	let lastPct = -1
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		received += value.byteLength
		if (!out.write(Buffer.from(value))) await new Promise<void>((resolve) => out.once('drain', resolve))
		if (total && onProgress) {
			const pct = Math.min(100, Math.floor((received / total) * 100))
			if (pct !== lastPct) {
				lastPct = pct
				onProgress(pct)
			}
		}
	}
	await new Promise<void>((resolve, reject) => {
		out.end((error?: Error) => (error ? reject(error) : resolve()))
	})
	return dest
}

/**
 * Downloads the zip, stages flow.app, and spawns a detached installer that
 * waits for this process to exit, swaps /Applications/flow.app, and relaunches.
 * The staging dir is intentionally left for the tmp cleaner — the script needs
 * it after we quit.
 */
async function installFromZip(zipUrl: string, appBundle: string, onProgress?: (pct: number) => void): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-update-'))
	try {
		const zipPath = await downloadFile(zipUrl, path.join(tmp, path.basename(new URL(zipUrl).pathname)), onProgress)
		onProgress?.(100)
		await new Promise<void>((resolve, reject) => {
			execFile('unzip', ['-q', '-o', zipPath, '-d', tmp], (error) => (error ? reject(error) : resolve()))
		})
		const staged = path.join(tmp, 'flow.app')
		if (!fs.existsSync(staged)) throw new Error('Update archive did not contain flow.app')
		const pid = process.pid
		const script = path.join(tmp, 'install.sh')
		fs.writeFileSync(
			script,
			`#!/bin/sh
while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done
sleep 0.5
rm -rf '${appBundle}'
cp -R '${staged}' '${appBundle}'
open '${appBundle}'
`,
		)
		fs.chmodSync(script, 0o755)
		const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
		child.unref()
		app.quit()
	} catch (error) {
		void dialog.showMessageBox({
			type: 'warning',
			message: 'Update failed',
			detail: error instanceof Error ? error.message : String(error),
		})
	}
}
