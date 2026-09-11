export {}

declare global {
	interface Window {
		flowHistory: {
			list: (opts?: { limit?: number; offset?: number; query?: string }) => Promise<{ rows: HistoryEntry[]; total: number }>
			clear: () => Promise<number>
			copy: (text: string) => void
		}
	}
}

// NOTE: plain <script src> like the pill renderer — dependency-free, no
// imports (see scripts/strip-cjs-prelude.js). HistoryEntry mirrors
// src/main/history.ts; textContent assignment keeps rendering XSS-safe.
interface HistoryEntry {
	id: number
	text: string
	provider: string
	source: string
	createdAt: number
}

const listEl = document.getElementById('list') as HTMLDivElement
const emptyEl = document.getElementById('empty') as HTMLDivElement
const filterEl = document.getElementById('filter') as HTMLInputElement
const clearBtn = document.getElementById('clear') as HTMLButtonElement
const prevBtn = document.getElementById('prev') as HTMLButtonElement
const nextBtn = document.getElementById('next') as HTMLButtonElement
const pageInfoEl = document.getElementById('pageinfo') as HTMLSpanElement

const PAGE_SIZE = 50
const FILTER_DEBOUNCE_MS = 250

let entries: HistoryEntry[] = []
let page = 1
let total = 0
let filterTimer: ReturnType<typeof setTimeout> | null = null

function row(entry: HistoryEntry): HTMLDivElement {
	const el = document.createElement('div')
	el.className = 'row'
	const time = document.createElement('div')
	time.className = 'time'
	time.textContent = new Date(entry.createdAt).toLocaleString()
	const text = document.createElement('div')
	text.className = 'text'
	text.textContent = entry.text
	const copy = document.createElement('button')
	copy.type = 'button'
	copy.className = 'copy'
	copy.textContent = 'Copy'
	copy.addEventListener('click', () => {
		window.flowHistory.copy(entry.text)
		copy.textContent = 'Copied'
		setTimeout(() => {
			copy.textContent = 'Copy'
		}, 1200)
	})
	el.append(time, text, copy)
	return el
}

function totalPages(): number {
	return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

function render(): void {
	listEl.replaceChildren()
	for (const entry of entries) listEl.append(row(entry))
	emptyEl.hidden = entries.length > 0
	const pages = totalPages()
	pageInfoEl.textContent = `Page ${page} of ${pages} · ${total} ${total === 1 ? 'entry' : 'entries'}`
	prevBtn.disabled = page <= 1
	nextBtn.disabled = page >= pages
}

async function refresh(): Promise<void> {
	const res = await window.flowHistory.list({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, query: filterEl.value.trim() })
	entries = res.rows
	entries.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
	total = res.total
	if (page > totalPages()) {
		// The page emptied out from under us (e.g. cleared elsewhere): step back.
		page = totalPages()
		void refresh()
		return
	}
	render()
}

filterEl.addEventListener('input', () => {
	if (filterTimer) clearTimeout(filterTimer)
	filterTimer = setTimeout(() => {
		filterTimer = null
		page = 1
		void refresh()
	}, FILTER_DEBOUNCE_MS)
})
prevBtn.addEventListener('click', () => {
	if (page <= 1) return
	page -= 1
	void refresh()
})
nextBtn.addEventListener('click', () => {
	if (page >= totalPages()) return
	page += 1
	void refresh()
})
clearBtn.addEventListener('click', () => {
	if (!window.confirm('Delete all transcriptions?')) return
	void window.flowHistory.clear().then(() => {
		page = 1
		return refresh()
	})
})
void refresh()
