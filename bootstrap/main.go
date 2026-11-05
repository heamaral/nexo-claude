package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Nexo:", err)
		os.Exit(1)
	}
}
func run() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	root := os.Getenv("CLAUDE_PLUGIN_ROOT")
	if root == "" {
		root = filepath.Dir(filepath.Dir(exe))
	}
	args := os.Args[1:]
	data := os.Getenv("CLAUDE_PLUGIN_DATA")
	override := os.Getenv("NEXO_NODE_PATH")
	for len(args) > 0 && strings.HasPrefix(args[0], "--") {
		if len(args) < 2 {
			return fmt.Errorf("missing launcher option value")
		}
		switch args[0] {
		case "--data":
			data = args[1]
		case "--node-override":
			if override == "" {
				override = args[1]
			}
		default:
			return fmt.Errorf("unknown launcher option %s", args[0])
		}
		args = args[2:]
	}
	manifest, err := readManifest(filepath.Join(root, "bootstrap", "runtime-manifest.json"))
	if err != nil {
		return fmt.Errorf("could not read the bundled runtime manifest: %w", err)
	}
	if data == "" || strings.Contains(data, "${") {
		config := os.Getenv("CLAUDE_CONFIG_DIR")
		if config == "" {
			home, e := os.UserHomeDir()
			if e != nil {
				return e
			}
			config = filepath.Join(home, ".claude")
		}
		data = filepath.Join(config, "plugins", "data", "nexo-nexo-marketplace")
	}
	data, err = filepath.Abs(data)
	if err != nil {
		return err
	}
	m := &Manager{Manifest: manifest, Data: data, Platform: nativePlatform(), Override: override, Log: os.Stderr}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(args) == 0 {
		args = []string{"help"}
	}
	m.Force = args[0] == "setup"
	if args[0] == "mcp" {
		return bridge(ctx, m, root, os.Stdin, os.Stdout, os.Stderr)
	}
	if args[0] == "runtime-status" {
		m.set("not-checked", "", nil)
		if a, ok := manifest.Artifacts[m.Platform]; ok && len(a.BinarySHA256) == 64 {
			if node := m.cached(a); node != "" {
				m.set("ready", node, nil)
			}
		}
		return json.NewEncoder(os.Stdout).Encode(m.State())
	}
	// Do not start Node for hooks in projects that do not use Nexo. MCP starts
	// automatic preparation independently, even before a project is initialized.
	var hookInput []byte
	if args[0] == "hook" {
		hookInput, err = io.ReadAll(io.LimitReader(os.Stdin, 262145))
		if err != nil {
			return err
		}
		if len(hookInput) > 262144 {
			return fmt.Errorf("hook input exceeds 256 KiB")
		}
		var body struct {
			Cwd string `json:"cwd"`
		}
		if err = json.Unmarshal(hookInput, &body); err != nil {
			return fmt.Errorf("invalid hook JSON")
		}
		cwd := os.Getenv("NEXO_PROJECT_ROOT")
		if cwd == "" {
			cwd = body.Cwd
		}
		if cwd == "" {
			cwd = os.Getenv("CLAUDE_PROJECT_DIR")
		}
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		if !hasProject(cwd) {
			return nil
		}
	}
	setupCtx, setupCancel := context.WithTimeout(ctx, 90*time.Second)
	node, err := m.Ensure(setupCtx)
	setupCancel()
	if err != nil {
		return err
	}
	if args[0] == "setup" {
		return json.NewEncoder(os.Stdout).Encode(m.State())
	}
	cmd := exec.CommandContext(ctx, node, append([]string{"--disable-warning=ExperimentalWarning", filepath.Join(root, "runtime", "cli.mjs")}, args...)...)
	cmd.Env = cleanNodeEnv()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if hookInput != nil {
		cmd.Stdin = bytes.NewReader(hookInput)
	} else {
		cmd.Stdin = os.Stdin
	}
	hideWindow(cmd)
	return cmd.Run()
}
func hasProject(dir string) bool {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	for {
		if s, e := os.Stat(filepath.Join(dir, ".nexo", "project.json")); e == nil && s.Mode().IsRegular() {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}
