// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HistoryEntry = { id: number; text: string; provider: string; source: string; createdAt: number }
type ListOpts = { limit?: number; offset?: number; query?: string }

let entries: HistoryEntry[] = []
const calls: Array<{ method: string; arg?: unknown }> = []

function loadHistoryUi(): Promise<void> {
	document.body.innerHTML =
		'<header><h1>History</h1><button id="clear">Clear</button></header>' +
		'<input id="filter" type="search" placeholder="Filter…" />' +
		'<div id="list"></div><div id="empty" hidden>No transcriptions yet.</div>' +
		'<div id="pager"><button id="prev">‹ Prev</button><span id="pageinfo"></span><button id="next">Next ›</button></div>'
	;(window as unknown as { flowHistory: unknown }).flowHistory = {
		// Faithful fake of the main-process contract: newest first, query
		// filter, then limit/offset slice, plus the matching-row total.
		list: (opts: ListOpts = {}) => {
			calls.push({ method: 'list', arg: opts })
			const q = (opts.query ?? '').trim().toLowerCase()
			const matching = entries.filter((e) => !q || e.text.toLowerCase().includes(q)).sort((a, b) => b.id - a.id)
			const offset = opts.offset ?? 0
			const limit = opts.limit ?? 50
			return Promise.resolve({ rows: matching.slice(offset, offset + limit), total: matching.length })
		},
		clear: () => {
			calls.push({ method: 'clear' })
			entries = []
			return Promise.resolve(0)
		},
		copy: (text: string) => calls.push({ method: 'copy', arg: text }),
	}
	vi.resetModules()
	return import('../src/history.js').then(() => undefined)
}

function rows(): HTMLElement[] {
	return Array.from(document.querySelectorAll('#list .row')) as HTMLElement[]
}

function rowText(row: HTMLElement): string {
	return row.querySelector('.text')?.textContent ?? ''
}

function pageInfo(): string {
	return (document.getElementById('pageinfo') as HTMLElement).textContent ?? ''
}

function makeEntries(n: number): HistoryEntry[] {
	return Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		text: `entry ${i + 1}`,
		provider: 'deepgram',
		source: 'fn',
		createdAt: 1700000000000 + i * 60000,
	}))
}

async function reloadWith(list: HistoryEntry[]): Promise<void> {
	entries = list
	await loadHistoryUi()
	await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0))
}

async function typeFilter(value: string): Promise<void> {
	const filter = document.getElementById('filter') as HTMLInputElement
	filter.value = value
	filter.dispatchEvent(new Event('input', { bubbles: true }))
	await vi.advanceTimersByTimeAsync(300)
}

beforeEach(async () => {
	vi.useFakeTimers()
	entries = [
		{ id: 1, text: 'older text', provider: 'deepgram', source: 'fn', createdAt: 1700000000000 },
		{ id: 2, text: 'newer text', provider: 'deepgram', source: 'mouse', createdAt: 1700000060000 },
	]
	calls.length = 0
	await loadHistoryUi()
	await vi.waitFor(() => expect(rows()).toHaveLength(2))
})

afterEach(() => {
	vi.useRealTimers()
})

describe('history window', () => {
	it('renders newest first with timestamps', () => {
		expect(rows().map(rowText)).toEqual(['newer text', 'older text'])
		expect(rows()[0].querySelector('.time')?.textContent).toContain('2023')
		expect((document.getElementById('empty') as HTMLElement).hidden).toBe(true)
	})

	it('shows the page count and disables both buttons on a single page', () => {
		expect(pageInfo()).toBe('Page 1 of 1 · 2 entries')
		expect((document.getElementById('prev') as HTMLButtonElement).disabled).toBe(true)
		expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(true)
	})

	it('filters as you type, newest first', async () => {
		await typeFilter('older')
		await vi.waitFor(() => expect(rows().map(rowText)).toEqual(['older text']))
		expect(pageInfo()).toBe('Page 1 of 1 · 1 entry')
		expect(calls).toContainEqual({ method: 'list', arg: expect.objectContaining({ query: 'older', offset: 0 }) })
	})

	it('pages forward and back', async () => {
		await reloadWith(makeEntries(55))
		expect(rows()).toHaveLength(50)
		expect(rowText(rows()[0])).toBe('entry 55')
		expect(pageInfo()).toBe('Page 1 of 2 · 55 entries')
		expect((document.getElementById('prev') as HTMLButtonElement).disabled).toBe(true)
		expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(false)

		;(document.getElementById('next') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(rows().map(rowText)).toEqual(['entry 5', 'entry 4', 'entry 3', 'entry 2', 'entry 1']))
		expect(pageInfo()).toBe('Page 2 of 2 · 55 entries')
		expect((document.getElementById('prev') as HTMLButtonElement).disabled).toBe(false)
		expect((document.getElementById('next') as HTMLButtonElement).disabled).toBe(true)

		;(document.getElementById('prev') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(rows()).toHaveLength(50))
		expect(rowText(rows()[0])).toBe('entry 55')
		expect(pageInfo()).toBe('Page 1 of 2 · 55 entries')
	})

	it('filtering resets to page 1', async () => {
		await reloadWith(makeEntries(55))
		;(document.getElementById('next') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(pageInfo()).toBe('Page 2 of 2 · 55 entries'))
		await typeFilter('entry 7')
		await vi.waitFor(() => expect(rows().map(rowText)).toEqual(['entry 7']))
		expect(pageInfo()).toBe('Page 1 of 1 · 1 entry')
	})

	it('copies on button click with feedback', () => {
		const btn = rows()[0].querySelector('.copy') as HTMLButtonElement
		btn.click()
		expect(calls).toContainEqual({ method: 'copy', arg: 'newer text' })
		expect(btn.textContent).toBe('Copied')
		vi.advanceTimersByTime(1500)
		expect(btn.textContent).toBe('Copy')
	})

	it('clears after confirm and shows the empty state', async () => {
		window.confirm = () => true
		;(document.getElementById('clear') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(rows()).toHaveLength(0))
		expect(calls).toContainEqual({ method: 'clear' })
		expect((document.getElementById('empty') as HTMLElement).hidden).toBe(false)
		expect(pageInfo()).toBe('Page 1 of 1 · 0 entries')
	})

	it('clearing from a later page lands on page 1', async () => {
		await reloadWith(makeEntries(55))
		;(document.getElementById('next') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(pageInfo()).toBe('Page 2 of 2 · 55 entries'))
		window.confirm = () => true
		;(document.getElementById('clear') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(rows()).toHaveLength(0))
		expect(pageInfo()).toBe('Page 1 of 1 · 0 entries')
	})

	it('asks before clearing', async () => {
		window.confirm = () => false
		;(document.getElementById('clear') as HTMLButtonElement).click()
		await vi.waitFor(() => expect(rows()).toHaveLength(2))
		expect(calls).not.toContainEqual({ method: 'clear' })
	})
})
