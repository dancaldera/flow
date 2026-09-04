// flow-fn-listener: minimal macOS `fn`-key event tap.
// Emits "down\n" / "up\n" on stdout for hold-to-talk.
// Requires Accessibility permission; run once to trigger the system prompt.
//
// Build: swiftc -o flow-fn-listener swift/fn-listener.swift -framework Cocoa
// The Electron main process spawns ./swift/flow-fn-listener when present and
// falls back to Option+Space otherwise.

import Cocoa

// --check: exit 0 iff an event tap can be created (i.e. the helper is
// trusted), without entering the run loop. Used by onboarding to report
// the fn-key capability honestly instead of probing another process.
let checkOnly = CommandLine.arguments.contains("--check")

let fnMask: UInt64 = 0x800000 // kCGEventFlagMaskSecondaryFn
var isDown = false

func emit(_ s: String) {
	print(s)
	fflush(stdout)
}

let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
guard let tap = CGEvent.tapCreate(
	tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
	eventsOfInterest: CGEventMask(mask),
	callback: { _, type, event, _ -> Unmanaged<CGEvent>? in
		if type == .flagsChanged {
			let flags = event.flags.rawValue
			let down = (flags & fnMask) != 0
			if down != isDown {
				isDown = down
				emit(down ? "down" : "up")
			}
		}
		if type == .tapDisabledByTimeout {
			return nil
		}
		return Unmanaged.passRetained(event)
	}, userInfo: nil
) else {
	fputs("flow-fn-listener: CGEventTap denied (enable Accessibility)\n", stderr)
	exit(1)
}

if checkOnly {
	print("flow-fn-listener: event tap ok")
	exit(0)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()
