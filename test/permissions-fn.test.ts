import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fnTapState } from '../src/main/permissions'

// /usr/bin/true|false ignore extra args, so they stand in for helper
// binaries whose --check exits 0 or 1.
const hasDoubles = existsSync('/usr/bin/true') && existsSync('/usr/bin/false')

describe('fnTapState', () => {
	it.skipIf(!hasDoubles)('reports granted when the helper check exits 0', async () => {
		await expect(fnTapState('/usr/bin/true')).resolves.toMatchObject({ state: 'granted' })
	})

	it.skipIf(!hasDoubles)('reports missing when the helper check fails', async () => {
		await expect(fnTapState('/usr/bin/false')).resolves.toMatchObject({ state: 'missing' })
	})

	it('reports unknown with a build hint when the helper is not built', async () => {
		const result = await fnTapState('/nonexistent/flow-fn-listener')
		expect(result.state).toBe('unknown')
		expect(result.hint).toMatch(/swiftc/)
	})
})
