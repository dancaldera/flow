// Post-build step for browser-loaded scripts.
//
// src/onboarding.ts and src/renderer.ts run via <script src> with
// nodeIntegration off, where CommonJS globals like `exports` do not exist.
// tsc still emits an `Object.defineProperty(exports, ...)` prelude for them,
// which throws on load and kills the whole script (blank provider list, dead
// buttons). Strip that prelude and fail the build if either file ever gains
// a real runtime import/require, which needs a bundler instead.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const targets = ['dist/src/onboarding.js', 'dist/src/renderer.js']
const prelude = 'Object.defineProperty(exports, "__esModule", { value: true });'
const forbidden = [/\bexports\b/, /\brequire\s*\(/, /^\s*import\s/m, /^\s*export\s/m]

let failed = false
for (const target of targets) {
	const file = path.join(root, target)
	let text = fs.readFileSync(file, 'utf8')
	if (!text.includes(prelude)) {
		console.error(`strip-cjs-prelude: expected prelude not found in ${target}`)
		failed = true
		continue
	}
	text = text.replace(prelude, '')
	for (const pattern of forbidden) {
		if (pattern.test(text)) {
			console.error(`strip-cjs-prelude: ${target} still contains module code (${pattern}); it cannot run via <script src>`)
			failed = true
		}
	}
	if (!failed) fs.writeFileSync(file, text)
}
if (failed) process.exit(1)
for (const target of targets) console.log(`strip-cjs-prelude: ${target} ok`)
