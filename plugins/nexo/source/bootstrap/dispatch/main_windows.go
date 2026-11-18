// The Windows entry point is a tiny 32-bit selector, which Windows can execute
// on both x64 and ARM64. All download, verification and MCP work then runs in
// the native-architecture helper, avoiding emulation overhead on every hook.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

func main() {
	var info [64]byte
	syscall.NewLazyDLL("kernel32.dll").NewProc("GetNativeSystemInfo").Call(uintptr(unsafe.Pointer(&info[0])))
	arch := ""
	switch uint16(info[0]) | uint16(info[1])<<8 {
	case 9:
		arch = "amd64"
	case 12:
		arch = "arm64"
	default:
		fmt.Fprintln(os.Stderr, "Nexo: automatic runtime setup requires 64-bit Windows (x64 or ARM64).")
		os.Exit(1)
	}
	file, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Nexo:", err)
		os.Exit(1)
	}
	cmd := exec.Command(filepath.Join(filepath.Dir(file), "nexo-windows-"+arch+".exe"), os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err = cmd.Run(); err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			os.Exit(e.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "Nexo: could not start the bundled launcher:", err)
		os.Exit(1)
	}
}
