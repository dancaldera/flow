// electron-builder afterSign hook: re-sign the app bundle with a STABLE
// designated requirement (bundle identifier + signing-cert fingerprint).
//
// Why: with a self-signed certificate, codesign's default designated
// requirement is cdhash-based — every release is a different "app" to the
// Keychain, so the "Flow Safe Storage" item (safeStorage's encryption key,
// which guards the provider API keys) re-prompts for access after every
// update. TCC permissions survive because they match on the certificate, but
// Keychain ACLs match on the designated requirement. Pinning it to the cert
// fingerprint keeps every future release matching the ACL — no more prompts.
//
// Runs after electron-builder has signed the .app and before the DMG/zip
// targets are packed, so installers carry the pinned requirement. Skipped for
// ad-hoc builds (no identity / "-"): there is nothing stable to pin.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/** @param {string} out `security find-identity -v -p codesigning` output */
function parseIdentities(out) {
	// Lines like: `  1) ABCDEF…40hex "Flow"`  (-v lists only valid identities)
	const ids = []
	for (const m of out.matchAll(/\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/g)) {
		ids.push({ sha1: m[1], name: m[2] })
	}
	return ids
}

function run(cmd, args) {
	return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

module.exports = async function afterSign(context) {
	if (context.platformName !== 'darwin') return
	const configured = context.packager.config.mac && context.packager.config.mac.identity
	if (configured === '-') return // explicit ad-hoc

	const identities = parseIdentities(run('security', ['find-identity', '-v', '-p', 'codesigning']))
	if (!identities.length) {
		console.log('[after-sign] no codesigning identity found (ad-hoc build) — skipping stable requirement')
		return
	}
	const identity = configured
		? identities.find((i) => i.name.includes(configured))
		: identities[0]
	if (!identity) throw new Error(`[after-sign] configured identity "${configured}" not found in keychain`)

	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`)
	const appId = context.packager.appInfo.id
	// The requirement new builds must satisfy: right bundle id, right cert —
	// any cdhash. H"…" with 40 hex chars is the cert's SHA-1 fingerprint.
	const requirement = `=designated => identifier "${appId}" and certificate leaf = H"${identity.sha1}"`

	console.log(`[after-sign] pinning stable designated requirement for ${identity.name}: ${requirement}`)
	execFileSync(
		'codesign',
		[
			'--force',
			'--sign',
			identity.name,
			'--entitlements',
			path.join(__dirname, '..', 'entitlements.mac.plist'),
			'--requirements',
			requirement,
			appPath,
		],
		{ stdio: 'inherit' },
	)
	// Fail the build rather than ship an app the Keychain would distrust.
	execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
	console.log('[after-sign] verified')
}
