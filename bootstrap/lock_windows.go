package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var lockFileEx = kernel.NewProc("LockFileEx")
var nativeSystemInfo = kernel.NewProc("GetNativeSystemInfo")

func tryFileLock(f *os.File) (bool, error) {
	var overlap syscall.Overlapped
	ok, _, err := lockFileEx.Call(f.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlap)))
	if ok != 0 {
		return true, nil
	}
	if err == syscall.Errno(33) {
		return false, nil
	}
	return false, fmt.Errorf("runtime installation lock: %w", err)
}

// The small 32-bit Windows bootstrap runs on x64 and ARM64 Windows. Node itself
// is selected for the native machine architecture, not the emulated launcher.
func nativePlatform() string {
	var info [64]byte
	nativeSystemInfo.Call(uintptr(unsafe.Pointer(&info[0])))
	architecture := uint16(info[0]) | uint16(info[1])<<8
	switch architecture {
	case 9:
		return "windows-amd64"
	case 12:
		return "windows-arm64"
	default:
		return "windows-unsupported"
	}
}
