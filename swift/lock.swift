// Locks the screen through login.framework — synthetic Ctrl+Cmd+Q keystrokes are
// unreliable for system shortcuts. `--check` only verifies the symbol resolves.
// Build: swiftc -O -o swift/flow-lock swift/lock.swift
import Foundation
let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/login", RTLD_NOW)
guard let handle, let sym = dlsym(handle, "SACLockScreenImmediate") else {
	FileHandle.standardError.write("SACLockScreenImmediate unavailable\n".data(using: .utf8)!)
	exit(2)
}
if CommandLine.arguments.contains("--check") { exit(0) }
typealias Fn = @convention(c) () -> Int32
exit(unsafeBitCast(sym, to: Fn.self)() == 0 ? 0 : 1)
