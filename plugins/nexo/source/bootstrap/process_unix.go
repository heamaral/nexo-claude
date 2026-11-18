//go:build !windows

package main

import (
	"os"
	"os/exec"
)

func hideWindow(cmd *exec.Cmd) {}
func syncDir(dir string) error {
	f, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
