package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type archiveEntry struct {
	name string
	body []byte
	link bool
}

func digest(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func fixtureArchive(t *testing.T, kind string, extra ...archiveEntry) ([]byte, Artifact) {
	t.Helper()
	binary := []byte("verified fixture executable; never executed by fixture tests\n")
	a := Artifact{Root: "node-fixture", Binary: "bin/node", BinarySHA256: digest(binary), BinarySize: int64(len(binary))}
	if kind == "zip" {
		a.Binary = "node.exe"
	}
	entries := []archiveEntry{{name: a.Root + "/" + a.Binary, body: binary}, {name: a.Root + "/LICENSE", body: []byte("Node license fixture")}}
	entries = append(entries, extra...)
	var buffer bytes.Buffer
	if kind == "zip" {
		z := zip.NewWriter(&buffer)
		for _, e := range entries {
			h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
			h.SetMode(0700)
			if e.link {
				h.SetMode(os.ModeSymlink | 0700)
			}
			w, err := z.CreateHeader(h)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = w.Write(e.body); err != nil {
				t.Fatal(err)
			}
		}
		if err := z.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		g := gzip.NewWriter(&buffer)
		z := tar.NewWriter(g)
		for _, e := range entries {
			h := &tar.Header{Name: e.name, Mode: 0700, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
			if e.link {
				h.Typeflag = tar.TypeSymlink
				h.Linkname = "outside"
				h.Size = 0
			}
			if err := z.WriteHeader(h); err != nil {
				t.Fatal(err)
			}
			if !e.link {
				if _, err := z.Write(e.body); err != nil {
					t.Fatal(err)
				}
			}
		}
		if err := z.Close(); err != nil {
			t.Fatal(err)
		}
		if err := g.Close(); err != nil {
			t.Fatal(err)
		}
	}
	a.SHA256 = digest(buffer.Bytes())
	return buffer.Bytes(), a
}
func fixtureManager(t *testing.T, kind string, handler func(http.ResponseWriter, *http.Request, []byte)) (*Manager, *atomic.Int32) {
	t.Helper()
	body, a := fixtureArchive(t, kind)
	count := &atomic.Int32{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if handler != nil {
			handler(w, r, body)
		} else {
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(s.Close)
	a.URL = s.URL + "/node." + map[string]string{"zip": "zip", "tar": "tar.gz"}[kind]
	platform := "unix-fixture"
	if kind == "zip" {
		platform = "windows-fixture"
	}
	m := &Manager{Manifest: Manifest{Version: "24.22.1", Artifacts: map[string]Artifact{platform: a}}, Data: filepath.Join(t.TempDir(), "cache with spaces"), Platform: platform, Client: s.Client(), Log: io.Discard, Check: func(context.Context, string, string) error { return nil }}
	return m, count
}
func ensure(t *testing.T, m *Manager) string {
	t.Helper()
	ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	node, err := m.Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return node
}
func installed(t *testing.T, m *Manager) []string {
	t.Helper()
	entries, err := os.ReadDir(m.cacheRoot())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".stage-") {
			out = append(out, e.Name())
		}
	}
	return out
}

func TestInstallAndOfflineReuse(t *testing.T) {
	for _, kind := range []string{"zip", "tar"} {
		t.Run(kind, func(t *testing.T) {
			m, count := fixtureManager(t, kind, nil)
			first := ensure(t, m)
			if !regular(filepath.Join(filepath.Dir(first), "LICENSE")) {
				t.Fatal("license was not installed")
			}
			m.Client = &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("offline") })}
			second := ensure(t, m)
			if first != second || count.Load() != 1 {
				t.Fatal("offline reuse attempted another download")
			}
			if m.State().Status != "ready" {
				t.Fatal(m.State())
			}
		})
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTamperedArchiveIsNeverActivated(t *testing.T) {
	m, _ := fixtureManager(t, "zip", func(w http.ResponseWriter, r *http.Request, b []byte) { _, _ = w.Write([]byte("untrusted executable")) })
	_, err := m.Ensure(context.Background())
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatal(err)
	}
	if len(installed(t, m)) != 0 {
		t.Fatal("unverified archive activated")
	}
}
func TestInterruptedDownloadCanRetry(t *testing.T) {
	var first atomic.Bool
	first.Store(true)
	m, count := fixtureManager(t, "tar", func(w http.ResponseWriter, r *http.Request, b []byte) {
		if first.Swap(false) {
			w.Header().Set("Content-Length", fmt.Sprint(len(b)+100))
			_, _ = w.Write(b[:len(b)/2])
			return
		}
		_, _ = w.Write(b)
	})
	ensure(t, m)
	if count.Load() != 2 || len(installed(t, m)) != 1 {
		t.Fatal("retry did not activate exactly one generation")
	}
	entries, _ := os.ReadDir(m.cacheRoot())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".stage-") {
			t.Fatal("failed staging was not cleaned")
		}
	}
}
func TestBoundedRetriesCooldownAndExplicitRecovery(t *testing.T) {
	var healthy atomic.Bool
	m, count := fixtureManager(t, "zip", func(w http.ResponseWriter, r *http.Request, b []byte) {
		if !healthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(b)
	})
	if _, err := m.Ensure(context.Background()); err == nil || count.Load() != 3 {
		t.Fatalf("expected exactly three bounded attempts: count=%d err=%v", count.Load(), err)
	}
	if _, err := m.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "cool down") || count.Load() != 3 {
		t.Fatalf("a second process should share the failure cooldown: count=%d err=%v", count.Load(), err)
	}
	healthy.Store(true)
	m.Force = true
	ensure(t, m)
	if count.Load() != 4 || len(installed(t, m)) != 1 {
		t.Fatal("explicit setup did not recover immediately")
	}
}
func TestRateLimitDoesNotRetryImmediately(t *testing.T) {
	m, count := fixtureManager(t, "tar", func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if _, err := m.Ensure(context.Background()); err == nil || count.Load() != 1 {
		t.Fatalf("rate limiting must not trigger immediate retries: count=%d err=%v", count.Load(), err)
	}
}
func TestCorruptCacheGetsNewImmutableGeneration(t *testing.T) {
	m, count := fixtureManager(t, "zip", nil)
	old := ensure(t, m)
	if err := os.WriteFile(old, []byte("corrupted cache"), 0700); err != nil {
		t.Fatal(err)
	}
	next := ensure(t, m)
	if next == old || count.Load() != 2 || len(installed(t, m)) != 2 {
		t.Fatal("corrupt cache was reused or overwritten")
	}
	b, _ := os.ReadFile(old)
	if string(b) != "corrupted cache" {
		t.Fatal("an existing generation was overwritten")
	}
}
func TestVersionUpgradeRetainsOldRuntime(t *testing.T) {
	m, count := fixtureManager(t, "zip", nil)
	old := ensure(t, m)
	m.Manifest.Version = "24.23.0"
	next := ensure(t, m)
	if next == old || !regular(old) || count.Load() != 2 {
		t.Fatal("upgrade replaced the old runtime in place")
	}
}
func TestExecutableDigestMismatchDoesNotRunProbe(t *testing.T) {
	m, _ := fixtureManager(t, "zip", nil)
	a := m.Manifest.Artifacts[m.Platform]
	a.BinarySHA256 = strings.Repeat("0", 64)
	m.Manifest.Artifacts[m.Platform] = a
	var probes int
	m.Check = func(context.Context, string, string) error { probes++; return nil }
	if _, err := m.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "executable checksum") {
		t.Fatal(err)
	}
	if probes != 0 || len(installed(t, m)) != 0 {
		t.Fatal("unverified executable was probed or activated")
	}
}
func TestFailedCapabilityProbeDoesNotActivate(t *testing.T) {
	m, _ := fixtureManager(t, "tar", nil)
	m.Check = func(context.Context, string, string) error { return fmt.Errorf("unsupported SQLite") }
	if _, err := m.Ensure(context.Background()); err == nil {
		t.Fatal("probe failure ignored")
	}
	if len(installed(t, m)) != 0 {
		t.Fatal("failed runtime activated")
	}
}
func TestArchivePathsAndDuplicateExecutableRejected(t *testing.T) {
	for _, kind := range []string{"zip", "tar"} {
		for _, name := range []string{"../escape", "/absolute", "node-fixture/../escape", "node-fixture\\escape", "node-fixture/bin/node"} {
			t.Run(kind+name, func(t *testing.T) {
				body, a := fixtureArchive(t, kind, archiveEntry{name: name, body: []byte("bad")})
				if kind == "zip" && name == "node-fixture/bin/node" {
					body, a = fixtureArchive(t, kind, archiveEntry{name: "node-fixture/node.exe", body: []byte("bad")})
				}
				dir := t.TempDir()
				archive := filepath.Join(dir, "archive")
				if err := os.WriteFile(archive, body, 0600); err != nil {
					t.Fatal(err)
				}
				a.URL = "https://example.invalid/file." + map[string]string{"zip": "zip", "tar": "tar.gz"}[kind]
				if err := extractRuntime(archive, dir, a); err == nil {
					t.Fatal("unsafe archive accepted")
				}
			})
		}
	}
}
func TestLockIsNotStolenByAge(t *testing.T) {
	m, count := fixtureManager(t, "zip", nil)
	if err := os.MkdirAll(m.cacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	a := m.Manifest.Artifacts[m.Platform]
	file, err := os.OpenFile(filepath.Join(m.cacheRoot(), m.key(a)+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	held, err := tryFileLock(file)
	if err != nil || !held {
		t.Fatal(err)
	}
	_ = os.Chtimes(file.Name(), time.Unix(0, 0), time.Unix(0, 0))
	ctx, c := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer c()
	if _, err = m.Ensure(ctx); err == nil || count.Load() != 0 {
		t.Fatal("live lock was stolen")
	}
	_ = file.Close()
	ensure(t, m)
}
func TestProductionDownloadRequiresHTTPS(t *testing.T) {
	m, count := fixtureManager(t, "zip", nil)
	m.Client = nil
	if _, err := m.Ensure(context.Background()); err == nil || count.Load() != 0 {
		t.Fatal("production used plaintext HTTP")
	}
}

func TestManagerChild(t *testing.T) {
	raw := os.Getenv("NEXO_TEST_CHILD_MANAGER")
	if raw == "" {
		t.Skip("subprocess fixture")
	}
	var cfg struct {
		Manifest Manifest
		Data     string
		Platform string
		Output   string
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatal(err)
	}
	m := &Manager{Manifest: cfg.Manifest, Data: cfg.Data, Platform: cfg.Platform, Client: &http.Client{}, Log: io.Discard, Check: func(context.Context, string, string) error { return nil }}
	node := ensure(t, m)
	if err := os.WriteFile(cfg.Output, []byte(node), 0600); err != nil {
		t.Fatal(err)
	}
}
func managerChild(t *testing.T, m *Manager, output string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(struct {
		Manifest Manifest
		Data     string
		Platform string
		Output   string
	}{m.Manifest, m.Data, m.Platform, output})
	cmd := exec.Command(exe, "-test.run=^TestManagerChild$")
	cmd.Env = append(os.Environ(), "NEXO_TEST_CHILD_MANAGER="+string(cfg))
	hideWindow(cmd)
	return cmd
}
func TestConcurrentProcessesDownloadOnce(t *testing.T) {
	m, count := fixtureManager(t, "zip", func(w http.ResponseWriter, r *http.Request, b []byte) {
		time.Sleep(150 * time.Millisecond)
		_, _ = w.Write(b)
	})
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	outputs := []string{}
	for i := 0; i < 4; i++ {
		output := filepath.Join(t.TempDir(), "result")
		outputs = append(outputs, output)
		cmd := managerChild(t, m, output)
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
	if count.Load() != 1 || len(installed(t, m)) != 1 {
		t.Fatalf("downloads=%d generations=%d", count.Load(), len(installed(t, m)))
	}
	first, _ := os.ReadFile(outputs[0])
	for _, p := range outputs {
		b, _ := os.ReadFile(p)
		if !bytes.Equal(first, b) {
			t.Fatal("processes selected different runtime generations")
		}
	}
}
func TestProcessCrashReleasesInstallationLock(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var requests atomic.Int32
	m, count := fixtureManager(t, "zip", func(w http.ResponseWriter, r *http.Request, b []byte) {
		if requests.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		_, _ = w.Write(b)
	})
	cmd := managerChild(t, m, filepath.Join(t.TempDir(), "result"))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("child did not begin download")
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	close(release)
	ensure(t, m)
	if count.Load() != 2 || len(installed(t, m)) != 1 {
		t.Fatal("process death did not release installation ownership")
	}
	entries, _ := os.ReadDir(m.cacheRoot())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".stage-") {
			t.Fatal("orphaned staging survived recovery")
		}
	}
}
