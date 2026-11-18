package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func fixture(t *testing.T) (string, string, config) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "bundled payload with spaces")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte("verified helper fixture\n"), 1000)
	var packed bytes.Buffer
	z := gzip.NewWriter(&packed)
	_, _ = z.Write(body)
	_ = z.Close()
	c := config{Payload: "helper.gz", PayloadDigest: digest(packed.Bytes()), HelperDigest: digest(body), Version: "1.0.0-test", Size: int64(len(body))}
	if err := os.WriteFile(filepath.Join(root, c.Payload), packed.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return root, filepath.Join(t.TempDir(), "private cache with spaces"), c
}
func ensure(t *testing.T, root, data string, c config) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	file, err := prepare(ctx, root, data, c)
	if err != nil {
		t.Fatal(err)
	}
	return file
}
func generations(data string) []string {
	entries, _ := os.ReadDir(filepath.Join(data, "launchers"))
	out := []string{}
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".stage-") {
			out = append(out, e.Name())
		}
	}
	return out
}
func TestVerifiedHelperAndOfflineReuse(t *testing.T) {
	root, data, c := fixture(t)
	first := ensure(t, root, data, c)
	if err := os.Remove(filepath.Join(root, c.Payload)); err != nil {
		t.Fatal(err)
	}
	if second := ensure(t, root, data, c); second != first {
		t.Fatal("did not reuse the verified cached helper")
	}
}
func TestCorruptionCreatesImmutableGeneration(t *testing.T) {
	root, data, c := fixture(t)
	old := ensure(t, root, data, c)
	if err := os.WriteFile(old, []byte("corrupted"), 0700); err != nil {
		t.Fatal(err)
	}
	next := ensure(t, root, data, c)
	if next == old || len(generations(data)) != 2 {
		t.Fatal("existing generation was replaced")
	}
	b, _ := os.ReadFile(old)
	if string(b) != "corrupted" {
		t.Fatal("old generation was overwritten")
	}
}
func TestTamperedPayloadAndExpandedDigestRejected(t *testing.T) {
	for _, tamper := range []string{"payload", "expanded"} {
		t.Run(tamper, func(t *testing.T) {
			root, data, c := fixture(t)
			if tamper == "payload" {
				if err := os.WriteFile(filepath.Join(root, c.Payload), []byte("wrong compressed bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				c.HelperDigest = strings.Repeat("0", 64)
			}
			if _, err := prepare(context.Background(), root, data, c); err == nil {
				t.Fatal("tampered helper activated")
			}
			if len(generations(data)) != 0 {
				t.Fatal("unverified helper generation persisted")
			}
		})
	}
}
func TestNativeHelperChild(t *testing.T) {
	raw := os.Getenv("NEXO_HELPER_CHILD")
	if raw == "" {
		t.Skip("subprocess fixture")
	}
	var f struct {
		Root, Data, Output, Hold string
		Config                   config
	}
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatal(err)
	}
	if f.Hold != "" {
		if err := os.MkdirAll(filepath.Join(f.Data, "launchers"), 0700); err != nil {
			t.Fatal(err)
		}
		lock, err := os.OpenFile(filepath.Join(f.Data, "launchers", key(f.Config)+".lock"), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		held, err := tryFileLock(lock)
		if err != nil || !held {
			t.Fatal("child lock failed", err)
		}
		if err := os.MkdirAll(filepath.Join(f.Data, "launchers", ".stage-"+key(f.Config)+"-abandoned"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.Hold, []byte("locked"), 0600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(60 * time.Second)
		return
	}
	file := ensure(t, f.Root, f.Data, f.Config)
	if err := os.WriteFile(f.Output, []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
}
func child(t *testing.T, root, data, output, hold string, c config) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(struct {
		Root, Data, Output, Hold string
		Config                   config
	}{root, data, output, hold, c})
	cmd := exec.Command(exe, "-test.run=^TestNativeHelperChild$")
	cmd.Env = append(os.Environ(), "NEXO_HELPER_CHILD="+string(raw))
	hideWindow(cmd)
	return cmd
}
func TestConcurrentNativePreparationUsesOneGeneration(t *testing.T) {
	root, data, c := fixture(t)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	outputs := []string{}
	for i := 0; i < 4; i++ {
		output := filepath.Join(t.TempDir(), "result")
		outputs = append(outputs, output)
		cmd := child(t, root, data, output, "", c)
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := cmd.CombinedOutput()
			if err != nil {
				errs <- fmt.Errorf("%w: %s", err, b)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(generations(data)) != 1 {
		t.Fatal("concurrent installers activated different generations")
	}
	first, _ := os.ReadFile(outputs[0])
	for _, file := range outputs {
		b, _ := os.ReadFile(file)
		if !bytes.Equal(first, b) {
			t.Fatal("clients selected different helpers")
		}
	}
}
func TestNativePreparationCrashReleasesLockWithoutStealing(t *testing.T) {
	root, data, c := fixture(t)
	hold := filepath.Join(t.TempDir(), "held")
	cmd := child(t, root, data, "", hold, c)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(hold); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if _, err := prepare(ctx, root, data, c); err == nil {
		t.Fatal("live native preparation lock was stolen")
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	ensure(t, root, data, c)
	entries, _ := os.ReadDir(filepath.Join(data, "launchers"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".stage-") {
			t.Fatal("abandoned staging was not cleaned")
		}
	}
}
