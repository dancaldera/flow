import { app, dialog, shell } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The repo is public: update checks hit the GitHub API unauthenticated.
export const GITHUB_REPO = 'dancaldera/flow'

export type ReleaseInfo = {
	tag: string
	version: string
	dmgUrl: string
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

/** Picks the release DMG asset matching this machine's architecture. */
export function pickAsset(assets: Array<{ name: string; browser_download_url: string }>, arch: string): string | null {
	const dmgs = assets.filter((a) => a.name.toLowerCase().endsWith('.dmg'))
	const match = dmgs.find((a) =>
		arch === 'arm64' ? a.name.toLowerCase().endsWith('-arm64.dmg') : !a.name.toLowerCase().includes('arm64'),
	)
	return match?.browser_download_url ?? null
}

/** Fetches the latest published release; null when none has a DMG asset. */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo | null> {
	const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
		headers: { Accept: 'application/vnd.github+json' },
	})
	if (res.status === 404) return null // repo has no published releases yet
	if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
	const data = (await res.json()) as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> }
	const tag = data.tag_name
	if (!tag) throw new Error('GitHub API response has no tag_name')
	const dmgUrl = pickAsset(data.assets ?? [], process.arch)
	if (!dmgUrl) return null
	return { tag, version: tag.replace(/^v/, ''), dmgUrl }
}

/** Interactive tray-menu flow: compare, confirm, download, open the installer. */
export async function checkForUpdates(): Promise<void> {
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
		const dmgPath = await downloadDmg(release.dmgUrl)
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

async function downloadDmg(url: string): Promise<string> {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
	const buf = Buffer.from(await res.arrayBuffer())
	const file = path.join(os.tmpdir(), path.basename(new URL(url).pathname))
	await fs.promises.writeFile(file, buf)
	return file
}
