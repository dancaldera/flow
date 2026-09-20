// Lean dev loop: rebuild + restart Electron on change. Node builtins only,
// no extra dependencies. Watches src/**/*.ts (full `tsc` re-emit + prelude
// strip, since the strip step only works on a fresh emit) and restarts the
// app for static files (index.html). onboarding.html and styles/** trigger
// a full rebuild too — Tailwind class scanning for dist/styles/onboarding.css
// depends on them.
//
// Usage: pnpm dev   (FLOW_DEV=1 is set on the child for future dev-only hooks)
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const twCli = path.join(
	path.dirname(require.resolve('@tailwindcss/cli/package.json')),
	require('@tailwindcss/cli/package.json').bin.tailwindcss,
)
const strip = path.join(__dirname, 'strip-cjs-prelude.js')
const electronPath = require('electron')

const REBUILD_DEBOUNCE_MS = 400
const RELAUNCH_DELAY_MS = 500

let app = null
let buildTimer = null
let relaunchTimer = null
let stopping = false

function log(message) {
	console.log(`[dev] ${message}`)
}

function build() {
	const compiled = spawnSync(process.execPath, [tsc], { cwd: root, stdio: 'inherit' })
	if (compiled.status !== 0) {
		log('tsc failed — fix the errors above, then save to retry')
		return false
	}
	const stripped = spawnSync(process.execPath, [strip], { cwd: root, stdio: 'inherit' })
	if (stripped.status !== 0) {
		log('strip-cjs-prelude failed')
		return false
	}
	const tailwind = spawnSync(
		process.execPath,
		[twCli, '-i', 'styles/onboarding.tw.css', '-o', 'dist/styles/onboarding.css', '--minify'],
		{ cwd: root, stdio: 'inherit' },
	)
	if (tailwind.status !== 0) {
		log('tailwindcss failed')
		return false
	}
	return true
}

function relaunch() {
	if (app) {
		log('restarting electron…')
		try {
			app.kill('SIGTERM')
		} catch {
			// already gone
		}
		app = null
	} else {
		log('starting electron…')
	}
	clearTimeout(relaunchTimer)
	relaunchTimer = setTimeout(() => {
		if (stopping) return
		const child = spawn(electronPath, [root], { stdio: 'inherit', env: { ...process.env, FLOW_DEV: '1' } })
		app = child
		child.on('exit', (code) => {
			// Stale exits (superseded by a relaunch) stay silent and must not
			// clear the tracker, or the live instance would be orphaned.
			if (stopping || app !== child) return
			app = null
			log(`electron exited (code=${code}) — save a file to relaunch, Ctrl+C to stop`)
		})
	}, RELAUNCH_DELAY_MS)
}

function scheduleRebuild() {
	if (stopping) return
	clearTimeout(buildTimer)
	buildTimer = setTimeout(() => {
		if (stopping) return
		log('change detected — rebuilding…')
		if (build()) relaunch()
	}, REBUILD_DEBOUNCE_MS)
}

function watch(target, onChange) {
	const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
		if (filename && /(^|[\\/])\../.test(filename)) return
		onChange(filename)
	})
	watcher.on('error', (error) => log(`watcher error on ${target}: ${error.message}`))
	return watcher
}

function shutdown() {
	if (stopping) return
	stopping = true
	clearTimeout(buildTimer)
	clearTimeout(relaunchTimer)
	if (app) {
		try {
			app.kill('SIGTERM')
		} catch {
			// already gone
		}
	}
	setTimeout(() => process.exit(0), 800).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

log('initial build…')
if (build()) relaunch()
else log('waiting for changes…')

watch(path.join(root, 'src'), (filename) => {
	if (!filename || !filename.endsWith('.ts')) return
	scheduleRebuild()
})
watch(path.join(root, 'index.html'), () => {
	if (stopping) return
	log('index.html changed — relaunching…')
	relaunch()
})
// onboarding.html is a Tailwind @source — class changes need a rebuild.
watch(path.join(root, 'onboarding.html'), () => {
	if (stopping) return
	log('onboarding.html changed — rebuilding…')
	scheduleRebuild()
})
watch(path.join(root, 'styles'), () => {
	if (stopping) return
	log('styles changed — rebuilding…')
	scheduleRebuild()
})

log('watching src/**/*.ts, *.html, styles/** (Ctrl+C to stop)')
