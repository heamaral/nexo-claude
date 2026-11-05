//go:build !windows

package main

import (
	"os"
	"syscall"
)

func tryFileLock(f *os.File) (bool, error) {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
		return false, nil
	}
	return err == nil, err
}
func nativePlatform() string { return hostPlatform() }
