import { BrowserWindow, app } from 'electron'
import * as path from 'node:path'

export function createPillWindow(preloadPath: string, indexPath: string): BrowserWindow {
	const win = new BrowserWindow({
		width: 340,
		height: 96,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		focusable: false,
		skipTaskbar: true,
		show: false,
		alwaysOnTop: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: preloadPath,
		},
	})

	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	win.setAlwaysOnTop(true, 'floating')
	win.setFullScreenable(false)
	win.setIgnoreMouseEvents(true, { forward: true })
	if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
	if (process.platform === 'darwin' && app.dock) app.dock.hide()

	void win.loadFile(indexPath)
	return win
}

export function resolvePaths(mainDir: string): { preloadPath: string; indexPath: string } {
	return {
		preloadPath: path.join(mainDir, 'preload.js'),
		indexPath: path.join(mainDir, '..', '..', 'index.html'),
	}
}

export function placePillBottomCenter(win: BrowserWindow): void {
	const { screen } = require('electron')
	const display = screen.getPrimaryDisplay()
	const area = display.workArea
	const [w, h] = win.getSize()
	win.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height - h - 48), false)
}
