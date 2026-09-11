import Cocoa

// flow-frontmost: frontmost-app query + activation for paste targeting.
// Clicking the pill activates Flow; before pasting, main re-activates the app
// that was frontmost when the mouse recording started.
//
// Usage:
//   flow-frontmost --print                  print "<pid> <bundleId>" of frontmost
//   flow-frontmost --activate <pid> <id>    activate pid if it still has id
//
// The pid+bundleId pair guards against pid reuse: a stale capture never
// activates an unrelated process.
//
// Build: swiftc -o swift/flow-frontmost swift/frontmost.swift -framework Cocoa

let args = CommandLine.arguments

if args.count >= 2 && args[1] == "--print" {
	if let front = NSWorkspace.shared.frontmostApplication {
		print("\(front.processIdentifier) \(front.bundleIdentifier ?? "")")
	} else {
		print("0 ")
	}
	exit(0)
}

if args.count >= 4 && args[1] == "--activate" {
	if let pid = Int32(args[2]), !args[3].isEmpty,
		let app = NSRunningApplication(processIdentifier: pid),
		app.bundleIdentifier == args[3]
	{
		app.activate()
		print("ok")
		exit(0)
	}
	fputs("flow-frontmost: no such app\n", stderr)
	exit(1)
}

fputs("usage: flow-frontmost --print | --activate <pid> <bundleId>\n", stderr)
exit(2)
