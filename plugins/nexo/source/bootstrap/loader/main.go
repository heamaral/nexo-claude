// The small native entry point verifies and expands the bundled helper locally.
// It performs no network calls. Node installation stays in the existing helper.
package main

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var payloadName, payloadDigest, helperDigest, helperSize, applicationVersion string

const maxHelper = int64(32 << 20)
const maxPayload = int64(5 << 20)

type config struct {
	Payload, PayloadDigest, HelperDigest, Version string
	Size                                          int64
}

func main() {
	if err := run(); err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			os.Exit(e.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "Nexo native preparation:", err)
		os.Exit(1)
	}
}
func run() error {
	file, err := os.Executable()
	if err != nil {
		return err
	}
	size, err := strconv.ParseInt(helperSize, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid bundled helper size")
	}
	c := config{payloadName, payloadDigest, helperDigest, applicationVersion, size}
	data := os.Getenv("CLAUDE_PLUGIN_DATA")
	args := os.Args[1:]
	for i := 0; i+1 < len(args) && strings.HasPrefix(args[i], "--"); i += 2 {
		if args[i] == "--data" {
			data = args[i+1]
		}
	}
	if data == "" || strings.Contains(data, "${") {
		base := os.Getenv("CLAUDE_CONFIG_DIR")
		if base == "" {
			home, e := os.UserHomeDir()
			if e != nil {
				return e
			}
			base = filepath.Join(home, ".claude")
		}
		data = filepath.Join(base, "plugins", "data", "nexo-nexo-marketplace")
	}
	data, err = filepath.Abs(data)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	installCtx, stop := context.WithTimeout(ctx, 10*time.Second)
	helper, err := prepare(installCtx, filepath.Dir(file), data, c)
	stop()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, helper, args...)
	cmd.Env = os.Environ()
	if os.Getenv("CLAUDE_PLUGIN_ROOT") == "" {
		cmd.Env = append(cmd.Env, "CLAUDE_PLUGIN_ROOT="+filepath.Dir(filepath.Dir(file)))
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	hideWindow(cmd)
	return cmd.Run()
}
func hashFile(file string, limit int64) (string, int64, error) {
	s, err := os.Lstat(file)
	if err != nil {
		return "", 0, err
	}
	if !s.Mode().IsRegular() || s.Size() < 1 || s.Size() > limit {
		return "", 0, fmt.Errorf("invalid helper file")
	}
	f, err := os.Open(file)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, limit+1))
	if n > limit {
		return "", n, fmt.Errorf("helper exceeds size limit")
	}
	return hex.EncodeToString(h.Sum(nil)), n, err
}
func key(c config) string {
	return "nexo-" + c.Version + "-" + runtime.GOOS + "-" + runtime.GOARCH + "-" + c.HelperDigest[:16]
}
func helperName() string {
	if runtime.GOOS == "windows" {
		return "nexo-helper.exe"
	}
	return "nexo-helper"
}
func cached(root string, c config) string {
	s, err := os.Lstat(root)
	if err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), key(c)+"-") {
			continue
		}
		file := filepath.Join(root, e.Name(), helperName())
		sum, size, err := hashFile(file, maxHelper)
		if err == nil && sum == c.HelperDigest && size == c.Size {
			if runtime.GOOS != "windows" {
				if err := os.Chmod(file, 0700); err != nil {
					continue
				}
			}
			return file
		}
	}
	return ""
}
func prepare(ctx context.Context, bundled, data string, c config) (string, error) {
	for _, hash := range []string{c.PayloadDigest, c.HelperDigest} {
		b, err := hex.DecodeString(hash)
		if err != nil || len(b) != 32 {
			return "", fmt.Errorf("invalid trusted helper digest")
		}
	}
	if c.Size < 1 || c.Size > maxHelper || filepath.Base(c.Payload) != c.Payload || c.Version == "" || strings.ContainsAny(c.Version, "/\\:") {
		return "", fmt.Errorf("invalid bundled helper configuration")
	}
	root := filepath.Join(data, "launchers")
	if helper := cached(root, c); helper != "" {
		return helper, nil
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("helper cache cannot be a symlink")
	}
	lock, err := os.OpenFile(filepath.Join(root, key(c)+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer lock.Close()
	for {
		held, err := tryFileLock(lock)
		if err != nil {
			return "", err
		}
		if held {
			break
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("timed out waiting for native preparation; no live lock was stolen")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if helper := cached(root, c); helper != "" {
		return helper, nil
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), ".stage-"+key(c)+"-") {
			_ = os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
	payload := filepath.Join(bundled, c.Payload)
	sum, _, err := hashFile(payload, maxPayload)
	if err != nil {
		return "", err
	}
	if sum != c.PayloadDigest {
		return "", fmt.Errorf("bundled helper checksum mismatch")
	}
	stage, err := os.MkdirTemp(root, ".stage-"+key(c)+"-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if err = unpack(payload, filepath.Join(stage, helperName()), c); err != nil {
		return "", err
	}
	if err = syncDir(stage); err != nil {
		return "", err
	}
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	target := filepath.Join(root, key(c)+"-"+hex.EncodeToString(nonce[:]))
	if err = activate(ctx, stage, target); err != nil {
		return "", err
	}
	if err = syncDir(root); err != nil {
		return "", err
	}
	return filepath.Join(target, helperName()), nil
}
func unpack(payload, target string, c config) error {
	f, err := os.Open(payload)
	if err != nil {
		return err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer z.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(z, c.Size+1))
	if copyErr == nil && (n != c.Size || hex.EncodeToString(h.Sum(nil)) != c.HelperDigest) {
		copyErr = fmt.Errorf("expanded helper checksum or size mismatch")
	}
	if copyErr == nil {
		copyErr = out.Sync()
	}
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
func activate(ctx context.Context, stage, target string) error {
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := os.Rename(stage, target)
		if err == nil {
			return nil
		}
		transient := os.IsPermission(err) || (runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33))))
		if !transient || time.Now().After(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
