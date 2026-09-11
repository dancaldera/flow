// @vitest-environment jsdom
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FlowState = { phase: string; message?: string; seconds?: number }

// Calls the renderer makes toward main, in order.
const calls: Array<{ method: string; arg?: unknown }> = []
let stateCb: ((s: FlowState) => void) | null = null

async function loadRenderer(): Promise<void> {
	// Fresh DOM per test; the renderer binds at import time.
	document.body.innerHTML =
		'<div id="pill"><span id="dot" class="dot idle"></span><div id="texts"><div id="hint"></div></div><span id="cta">Hold to talk</span><span id="cta-alt">Double-click to latch</span></div>'
	calls.length = 0
	stateCb = null
	;(window as unknown as { flow: unknown }).flow = {
		onState: (cb: (s: FlowState) => void) => {
			stateCb = cb
		},
		onCommand: () => {},
		audioChunk: (...args: unknown[]) => calls.push({ method: 'audioChunk', arg: args }),
		start: () => calls.push({ method: 'start' }),
		stop: () => calls.push({ method: 'stop' }),
		setHover: (hovering: boolean) => calls.push({ method: 'setHover', arg: hovering }),
	}
	vi.resetModules()
	await import('../src/renderer.js')
}

function pill(): HTMLElement {
	return document.getElementById('pill') as HTMLElement
}

function down(): void {
	pill().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

function up(): void {
	window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

function enter(): void {
	pill().dispatchEvent(new MouseEvent('mouseenter'))
}

function leave(): void {
	pill().dispatchEvent(new MouseEvent('mouseleave'))
}

function setPhase(phase: string, seconds?: number): void {
	stateCb?.({ phase, seconds })
}

function hintText(): string {
	return (document.getElementById('hint') as HTMLElement).textContent ?? ''
}

function methods(): string[] {
	return calls.map((c) => c.method)
}

function hoverArgs(): unknown[] {
	return calls.filter((c) => c.method === 'setHover').map((c) => c.arg)
}

beforeEach(async () => {
	vi.useFakeTimers()
	await loadRenderer()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('pill hover', () => {
	it('reports hover while the cursor is over the idle pill', () => {
		enter()
		expect(hoverArgs().at(-1)).toBe(true)
		expect(document.body.dataset.hover).toBe('true')
		leave()
		expect(hoverArgs().at(-1)).toBe(false)
		expect(document.body.dataset.hover).toBe('false')
	})

	it('does not expand while recording', () => {
		setPhase('listening')
		enter()
		expect(document.body.dataset.hover).toBe('false')
	})
})

describe('tap and hold', () => {
	it('stops on release after a hold', () => {
		down()
		setPhase('listening')
		vi.advanceTimersByTime(600)
		up()
		expect(methods()).toContain('start')
		expect(methods()).toContain('stop')
	})

	it('holds a tap briefly to catch a second tap, then stops', () => {
		down()
		setPhase('listening')
		vi.advanceTimersByTime(100)
		up()
		// No stop yet: a second tap within the window latches instead.
		expect(methods()).not.toContain('stop')
		vi.advanceTimersByTime(500)
		expect(methods()).toContain('stop')
	})

	it('latches on double-tap: no stop after either release', () => {
		down()
		setPhase('listening')
		vi.advanceTimersByTime(100)
		up()
		vi.advanceTimersByTime(150)
		down()
		vi.advanceTimersByTime(100)
		up()
		vi.advanceTimersByTime(600)
		expect(methods().filter((m) => m === 'start')).toHaveLength(1)
		expect(methods()).not.toContain('stop')
		expect(document.body.dataset.hover).toBe('true')
	})

	it('stops a latched recording on the next press', () => {
		down()
		setPhase('listening')
		vi.advanceTimersByTime(100)
		up()
		vi.advanceTimersByTime(150)
		down()
		vi.advanceTimersByTime(100)
		up()
		down()
		expect(methods()).toContain('stop')
		up()
		expect(methods().filter((m) => m === 'stop')).toHaveLength(1)
	})

	it('cancels a pending tap when the phase changes first', () => {
		down()
		setPhase('listening')
		vi.advanceTimersByTime(100)
		up()
		setPhase('idle')
		vi.advanceTimersByTime(500)
		expect(methods()).not.toContain('stop')
	})

	it('resets locally when main never confirms the start', () => {
		down()
		// No setPhase('listening'): main guarded the start.
		vi.advanceTimersByTime(100)
		up()
		expect(methods()).not.toContain('stop')
		expect(hoverArgs().at(-1)).toBe(false)
		// Still fully functional afterwards.
		enter()
		expect(hoverArgs().at(-1)).toBe(true)
	})

	it('shows how to stop while latched, then clears it', () => {
		down()
		setPhase('listening', 0)
		vi.advanceTimersByTime(100)
		up()
		vi.advanceTimersByTime(150)
		down()
		vi.advanceTimersByTime(100)
		up()
		setPhase('listening', 3)
		expect(hintText()).toBe('Listening… 3s · click to stop')
		setPhase('working')
		expect(hintText()).toBe('Transcribing…')
	})

	it('shows no stop hint for non-mouse recordings', () => {
		setPhase('listening', 2)
		expect(hintText()).toBe('Listening… 2s')
	})
})

describe('pill hover copy', () => {
	it('keeps both hints in markup and styles', () => {
		const root = process.cwd()
		const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
		const css = fs.readFileSync(path.join(root, 'styles', 'pill.css'), 'utf8')
		expect(html).toContain('id="cta"')
		expect(html).toContain('Hold to talk')
		expect(html).toContain('id="cta-alt"')
		expect(html).toContain('Double-click to latch')
		expect(css).toContain('#cta-alt')
		expect(css).toContain('user-select: none')
	})
})
