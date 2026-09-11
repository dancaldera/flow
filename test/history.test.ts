import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
	app: { getPath: (name: string) => `/tmp/flow-history-test/${name}` },
}))

import { clearHistory, getHistoryDbPath, listTranscriptions, openHistoryDb, recordTranscription } from '../src/main/history'

function openMemory() {
	return openHistoryDb(':memory:')
}

function seed(db: ReturnType<typeof openMemory>, texts: string[]) {
	for (const text of texts) recordTranscription(db, { text, provider: 'p', source: 'fn' })
}

describe('history store', () => {
	it('records and lists newest first', () => {
		const db = openMemory()
		recordTranscription(db, { text: 'first', provider: 'deepgram', source: 'fn' })
		recordTranscription(db, { text: 'second', provider: 'deepgram', source: 'mouse' })
		const { rows, total } = listTranscriptions(db)
		expect(rows.map((r) => r.text)).toEqual(['second', 'first'])
		expect(total).toBe(2)
		expect(rows[0].provider).toBe('deepgram')
		expect(rows[0].source).toBe('mouse')
		expect(typeof rows[0].createdAt).toBe('number')
		expect(rows[0].id).toBeGreaterThan(rows[1].id)
		db.close()
	})

	it('ignores empty transcriptions', () => {
		const db = openMemory()
		expect(recordTranscription(db, { text: '   ', provider: 'deepgram', source: 'fn' })).toBeNull()
		expect(listTranscriptions(db)).toEqual({ rows: [], total: 0 })
		db.close()
	})

	it('keeps everything without pruning', () => {
		const db = openMemory()
		for (let i = 0; i < 1005; i++) recordTranscription(db, { text: `t${i}`, provider: 'p', source: 'fn' })
		const { rows, total } = listTranscriptions(db)
		expect(total).toBe(1005)
		expect(rows).toHaveLength(50)
		expect(rows[0].text).toBe('t1004')
		db.close()
	})

	it('pages through results with limit and offset', () => {
		const db = openMemory()
		seed(db, ['a', 'b', 'c', 'd', 'e'])
		const p1 = listTranscriptions(db, { limit: 2, offset: 0 })
		const p2 = listTranscriptions(db, { limit: 2, offset: 2 })
		const p3 = listTranscriptions(db, { limit: 2, offset: 4 })
		expect(p1.rows.map((r) => r.text)).toEqual(['e', 'd'])
		expect(p2.rows.map((r) => r.text)).toEqual(['c', 'b'])
		expect(p3.rows.map((r) => r.text)).toEqual(['a'])
		expect(p3.total).toBe(5)
		db.close()
	})

	it('returns empty rows past the end', () => {
		const db = openMemory()
		seed(db, ['a'])
		expect(listTranscriptions(db, { limit: 10, offset: 99 })).toEqual({ rows: [], total: 1 })
		db.close()
	})

	it('clamps limit and offset to sane bounds', () => {
		const db = openMemory()
		seed(db, ['a', 'b', 'c'])
		expect(listTranscriptions(db, { limit: 0, offset: -5 }).rows.map((r) => r.text)).toEqual(['c', 'b', 'a'])
		expect(listTranscriptions(db, { limit: 100000 }).rows).toHaveLength(3)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(listTranscriptions(db, { limit: NaN, offset: NaN } as any).rows.map((r) => r.text)).toEqual(['c', 'b', 'a'])
		db.close()
	})

	it('filters by query, newest first', () => {
		const db = openMemory()
		seed(db, ['buy milk', 'call mom', 'buy bread'])
		const { rows, total } = listTranscriptions(db, { query: 'BUY' })
		expect(rows.map((r) => r.text)).toEqual(['buy bread', 'buy milk'])
		expect(total).toBe(2)
		db.close()
	})

	it('treats LIKE wildcards in the query literally', () => {
		const db = openMemory()
		seed(db, ['100% sure_thing', 'something else'])
		expect(listTranscriptions(db, { query: '100%' }).rows.map((r) => r.text)).toEqual(['100% sure_thing'])
		expect(listTranscriptions(db, { query: 'sure_thing' }).rows.map((r) => r.text)).toEqual(['100% sure_thing'])
		expect(listTranscriptions(db, { query: '_' }).rows.map((r) => r.text)).toEqual(['100% sure_thing'])
		db.close()
	})

	it('treats a blank query as no filter', () => {
		const db = openMemory()
		seed(db, ['a'])
		expect(listTranscriptions(db, { query: '   ' }).total).toBe(1)
		db.close()
	})

	it('clears everything', () => {
		const db = openMemory()
		recordTranscription(db, { text: 'x', provider: 'p', source: 'fn' })
		expect(clearHistory(db)).toBe(1)
		expect(listTranscriptions(db)).toEqual({ rows: [], total: 0 })
		db.close()
	})

	it('lives next to the other app data', () => {
		expect(getHistoryDbPath()).toBe('/tmp/flow-history-test/userData/flow-history.db')
	})

	it('migrates pre-meeting databases to allow the meeting source', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-history-migrate-'))
		const file = path.join(dir, 'flow-history.db')
		const legacy = new DatabaseSync(file)
		legacy.exec(`CREATE TABLE transcriptions (
			id INTEGER PRIMARY KEY,
			text TEXT NOT NULL CHECK (length(text) > 0),
			provider TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'fn', 'shortcut', 'mouse')),
			created_at INTEGER NOT NULL
		)`)
		legacy.exec(`INSERT INTO transcriptions (text, provider, source, created_at) VALUES ('old', 'p', 'fn', 1)`)
		legacy.close()
		const db = openHistoryDb(file)
		const id = recordTranscription(db, { text: 'm', provider: 'p', source: 'meeting' })
		expect(id).toBeGreaterThan(1)
		expect(listTranscriptions(db).rows.map((r) => r.text)).toEqual(['m', 'old'])
		db.close()
		// Reopening a migrated database is a no-op, not an error.
		const reopened = openHistoryDb(file)
		expect(listTranscriptions(reopened).total).toBe(2)
		reopened.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})
})
