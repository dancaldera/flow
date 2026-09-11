import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface HistoryEntry {
	id: number
	text: string
	provider: string
	source: string
	createdAt: number
}

export interface NewTranscription {
	text: string
	provider: string
	source: string
}

export interface HistoryListOptions {
	limit?: number
	offset?: number
	query?: string
}

export interface HistoryPage {
	rows: HistoryEntry[]
	total: number
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

const TRANSCRIPTIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS transcriptions (
		id INTEGER PRIMARY KEY,
		text TEXT NOT NULL CHECK (length(text) > 0),
		provider TEXT NOT NULL DEFAULT '',
		source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'fn', 'shortcut', 'mouse', 'meeting')),
		created_at INTEGER NOT NULL
	)`

export function getHistoryDbPath(): string {
	return path.join(app.getPath('userData'), 'flow-history.db')
}

export function openHistoryDb(filePath: string): DatabaseSync {
	if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true })
	const db = new DatabaseSync(filePath)
	db.exec(TRANSCRIPTIONS_SCHEMA)
	migrateSourceCheck(db)
	db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions (created_at DESC, id DESC)')
	db.exec('PRAGMA journal_mode = WAL')
	return db
}

// SQLite cannot ALTER a CHECK constraint, so pre-meeting databases are
// rebuilt: rename, recreate with the new schema, copy rows back (ids and
// timestamps preserved), drop the legacy table.
function migrateSourceCheck(db: DatabaseSync): void {
	const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transcriptions'`).get() as unknown as { sql: string } | undefined
	if (!row?.sql || row.sql.includes(`'meeting'`)) return
	db.exec('ALTER TABLE transcriptions RENAME TO transcriptions_legacy')
	db.exec(TRANSCRIPTIONS_SCHEMA)
	db.exec('INSERT INTO transcriptions (id, text, provider, source, created_at) SELECT id, text, provider, source, created_at FROM transcriptions_legacy')
	db.exec('DROP TABLE transcriptions_legacy')
}

/** Records one transcription; returns the row id, or null for empty text. */
export function recordTranscription(db: DatabaseSync, t: NewTranscription): number | null {
	const text = t.text.trim()
	if (!text) return null
	const result = db.prepare('INSERT INTO transcriptions (text, provider, source, created_at) VALUES (?, ?, ?, ?)').run(text, t.provider, t.source, Date.now())
	return Number(result.lastInsertRowid)
}

/**
 * One page of history, newest first, plus the total matching-row count for the
 * pager. Options are coerced here so every caller (incl. IPC) gets sane bounds.
 */
export function listTranscriptions(db: DatabaseSync, opts: HistoryListOptions = {}): HistoryPage {
	const rawLimit = typeof opts.limit === 'number' ? Math.floor(opts.limit) : NaN
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_PAGE_SIZE, rawLimit) : DEFAULT_PAGE_SIZE
	const rawOffset = typeof opts.offset === 'number' ? Math.floor(opts.offset) : NaN
	const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
	const query = typeof opts.query === 'string' ? opts.query.trim().slice(0, 100) : ''
	// LIKE wildcards in the query are literal text, not pattern syntax.
	const pattern = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
	const where = pattern ? `WHERE text LIKE ? ESCAPE '\\'` : ''
	const rows = db.prepare(`SELECT id, text, provider, source, created_at AS createdAt FROM transcriptions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
		.all(...(pattern ? [pattern] : []), limit, offset) as unknown as HistoryEntry[]
	const row = db.prepare(`SELECT COUNT(*) AS total FROM transcriptions ${where}`).get(...(pattern ? [pattern] : [])) as unknown as { total: number }
	return { rows, total: Number(row.total) }
}

/** Deletes everything; returns the removed row count. */
export function clearHistory(db: DatabaseSync): number {
	return Number(db.prepare('DELETE FROM transcriptions').run().changes)
}
