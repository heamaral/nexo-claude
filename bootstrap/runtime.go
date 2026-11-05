package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Artifact struct {
	URL          string `json:"url"`
	SHA256       string `json:"sha256"`
	BinarySHA256 string `json:"binarySha256"`
	BinarySize   int64  `json:"binarySize"`
	Root         string `json:"root"`
	Binary       string `json:"binary"`
}
type Manifest struct {
	Version            string              `json:"version"`
	ApplicationVersion string              `json:"applicationVersion"`
	Protocols          []string            `json:"protocols"`
	Artifacts          map[string]Artifact `json:"artifacts"`
}
type RuntimeState struct {
	Mode     string `json:"mode"`
	Status   string `json:"status"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Path     string `json:"path,omitempty"`
	Error    string `json:"error,omitempty"`
}
type Manager struct {
	Manifest Manifest
	Data     string
	Platform string
	Override string
	Force    bool
	Client   *http.Client
	Log      io.Writer
	Check    func(context.Context, string, string) error
	mu       sync.Mutex
	state    RuntimeState
}

func hostPlatform() string { return runtime.GOOS + "-" + runtime.GOARCH }
func (m *Manager) set(status, node string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mode := "managed"
	if m.Override != "" && m.Override != "node" {
		mode = "override"
	}
	m.state = RuntimeState{Mode: mode, Status: status, Version: m.Manifest.Version, Platform: m.Platform, Path: node}
	if err != nil {
		m.state.Error = err.Error()
	}
}
func (m *Manager) State() RuntimeState { m.mu.Lock(); defer m.mu.Unlock(); return m.state }
func fileDigest(file string) (string, int64, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxBinary+1))
	if n > maxBinary {
		return "", n, fmt.Errorf("runtime binary exceeds size limit")
	}
	return hex.EncodeToString(h.Sum(nil)), n, err
}
func regular(file string) bool { s, e := os.Lstat(file); return e == nil && s.Mode().IsRegular() }
func nodeName(platform string) string {
	if strings.HasPrefix(platform, "windows-") {
		return "node.exe"
	}
	return "node"
}
func (m *Manager) cacheRoot() string { return filepath.Join(m.Data, "runtimes") }
func (m *Manager) key(a Artifact) string {
	return "node-" + m.Manifest.Version + "-" + m.Platform + "-" + a.BinarySHA256[:16]
}
func (m *Manager) cached(a Artifact) string {
	if s, err := os.Lstat(m.cacheRoot()); err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	entries, err := os.ReadDir(m.cacheRoot())
	if err != nil {
		return ""
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), m.key(a)+"-") {
			continue
		}
		file := filepath.Join(m.cacheRoot(), e.Name(), nodeName(m.Platform))
		if !regular(file) || !regular(filepath.Join(filepath.Dir(file), "LICENSE")) {
			continue
		}
		sum, size, err := fileDigest(file)
		if err == nil && sum == a.BinarySHA256 && size == a.BinarySize {
			if runtime.GOOS != "windows" {
				if err = os.Chmod(file, 0700); err != nil {
					continue
				}
			}
			return file
		}
	}
	return ""
}
func (m *Manager) check(ctx context.Context, node, version string) error {
	if m.Check != nil {
		return m.Check(ctx, node, version)
	}
	return probe(ctx, node, version)
}
func cleanNodeEnv() []string {
	out := []string{}
	for _, e := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(e, "=", 2)[0])
		if key != "NODE_OPTIONS" && key != "NODE_PATH" {
			out = append(out, e)
		}
	}
	return out
}
func probe(ctx context.Context, node string, exact string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	code := `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:',{timeout:1000});db.exec('CREATE TABLE probe(value INTEGER)');db.prepare('INSERT INTO probe VALUES(?)').run(1);if(db.prepare('SELECT value FROM probe').get().value!==1)process.exit(2);db.close();console.log(process.versions.node)`
	cmd := exec.CommandContext(ctx, node, "--disable-warning=ExperimentalWarning", "-e", code)
	cmd.Env = cleanNodeEnv()
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("Node/SQLite capability check failed; the executable must support Node 24.22.x and the host OS: %w", err)
	}
	version := strings.TrimSpace(string(out))
	if exact != "" && version != exact {
		return fmt.Errorf("runtime version mismatch: expected %s", exact)
	}
	var major, minor, patch int
	if _, err = fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch); err != nil || major != 24 || minor < 22 {
		return fmt.Errorf("the Node override must be version 24.22.0 or newer within major 24")
	}
	return nil
}
func (m *Manager) Ensure(ctx context.Context) (node string, err error) {
	defer func() {
		if err != nil {
			m.set("error", "", err)
		} else {
			m.set("ready", node, nil)
		}
	}()
	if m.Platform == "" {
		m.Platform = nativePlatform()
	}
	m.set("checking", "", nil)
	if m.Override != "" && m.Override != "node" {
		node, err = exec.LookPath(m.Override)
		if err != nil {
			return "", fmt.Errorf("configured Node override was not found; clear NEXO_NODE_PATH for managed setup")
		}
		node, err = filepath.Abs(node)
		if err != nil {
			return "", err
		}
		err = m.check(ctx, node, "")
		return
	}
	a, ok := m.Manifest.Artifacts[m.Platform]
	if !ok {
		return "", fmt.Errorf("unsupported platform %s; supported targets are Windows x64/ARM64, macOS x64/ARM64 and glibc Linux x64/ARM64", m.Platform)
	}
	hashPattern := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if !hashPattern.MatchString(a.SHA256) || !hashPattern.MatchString(a.BinarySHA256) || a.BinarySize < 1 || a.BinarySize > maxBinary {
		return "", fmt.Errorf("invalid pinned runtime manifest")
	}
	if m.Client == nil && !strings.HasPrefix(a.URL, "https://") {
		return "", fmt.Errorf("runtime download must use HTTPS")
	}
	if m.Data == "" {
		return "", fmt.Errorf("CLAUDE_PLUGIN_DATA is missing; invoke the installed plugin or pass --data <private-cache-directory>")
	}
	if node = m.cached(a); node != "" {
		return node, nil
	}
	if err = os.MkdirAll(m.cacheRoot(), 0700); err != nil {
		return "", err
	}
	if info, e := os.Lstat(m.cacheRoot()); e != nil || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("runtime cache cannot be a symlink")
	}
	lock, err := os.OpenFile(filepath.Join(m.cacheRoot(), m.key(a)+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer lock.Close()
	m.set("waiting-for-installation", "", nil)
	for {
		held, e := tryFileLock(lock)
		if e != nil {
			return "", e
		}
		if held {
			break
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("runtime setup timed out waiting for another installer; no live lock was stolen")
		case <-time.After(100 * time.Millisecond):
		}
	}
	if node = m.cached(a); node != "" {
		return node, nil
	}
	if !m.Force {
		if failure := m.recentFailure(a); failure != "" {
			return "", fmt.Errorf("recent runtime setup failed: %s; automatic attempts cool down for up to 30 seconds, or run the launcher setup command to retry immediately", failure)
		}
	}
	defer func() {
		if err != nil {
			m.rememberFailure(a, err)
		}
	}()
	// Only this key's abandoned staging directories are removed under its OS
	// lock. Installed generations and lock files are never removed.
	entries, _ := os.ReadDir(m.cacheRoot())
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), ".stage-"+m.key(a)+"-") {
			_ = os.RemoveAll(filepath.Join(m.cacheRoot(), e.Name()))
		}
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), m.key(a)+".failure-") {
			_ = os.Remove(filepath.Join(m.cacheRoot(), e.Name()))
		}
	}
	stage, err := os.MkdirTemp(m.cacheRoot(), ".stage-"+m.key(a)+"-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	archive := filepath.Join(stage, "download")
	m.set("downloading", "", nil)
	if m.Log != nil {
		fmt.Fprintln(m.Log, "Nexo: preparing its private Node runtime; global Node and PATH are unchanged.")
	}
	for attempt := 0; attempt < 3; attempt++ {
		err = m.download(ctx, a, archive)
		if err == nil {
			break
		}
		var transient *downloadFailure
		if !errors.As(err, &transient) || !transient.Retryable || attempt == 2 {
			return "", err
		}
		if removeErr := os.Remove(archive); removeErr != nil && !os.IsNotExist(removeErr) {
			return "", removeErr
		}
		if m.Log != nil {
			fmt.Fprintln(m.Log, "Nexo: runtime download interrupted; retrying verified setup.")
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("runtime setup deadline reached; retry when network access is available")
		case <-time.After(time.Duration(200*(1<<attempt)+mathrand.IntN(100)) * time.Millisecond):
		}
	}
	m.set("verifying", "", nil)
	if err = extractRuntime(archive, stage, a); err != nil {
		return "", fmt.Errorf("invalid runtime archive: %w", err)
	}
	node = filepath.Join(stage, nodeName(m.Platform))
	sum, size, err := fileDigest(node)
	if err != nil || sum != a.BinarySHA256 || size != a.BinarySize {
		return "", fmt.Errorf("runtime executable checksum mismatch; installation was not activated")
	}
	if err = m.check(ctx, node, m.Manifest.Version); err != nil {
		return "", err
	}
	if err = os.Remove(archive); err != nil {
		return "", err
	}
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	target := filepath.Join(m.cacheRoot(), m.key(a)+"-"+hex.EncodeToString(nonce[:]))
	if err = syncDir(stage); err != nil {
		return "", err
	}
	m.set("activating", "", nil)
	if err = activateRuntime(ctx, stage, target); err != nil {
		return "", err
	}
	if err = syncDir(m.cacheRoot()); err != nil {
		return "", err
	}
	return filepath.Join(target, nodeName(m.Platform)), nil
}
func activateRuntime(ctx context.Context, stage, target string) error {
	deadline := time.Now().Add(3 * time.Second)
	for attempt := 0; ; attempt++ {
		err := os.Rename(stage, target)
		if err == nil {
			return nil
		}
		transient := os.IsPermission(err) || (runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33))))
		if !transient || time.Now().After(deadline) {
			return err
		}
		wait := time.Duration(40*(1<<min(attempt, 3))+mathrand.IntN(40)) * time.Millisecond
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}
func (m *Manager) recentFailure(a Artifact) string {
	entries, _ := os.ReadDir(m.cacheRoot())
	newest := int64(0)
	message := ""
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), m.key(a)+".failure-") {
			continue
		}
		file := filepath.Join(m.cacheRoot(), e.Name())
		s, err := os.Lstat(file)
		if err != nil || s.Size() > 16384 {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var f struct {
			At      int64  `json:"at"`
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &f) == nil && f.At > newest {
			newest = f.At
			message = f.Message
		}
	}
	age := time.Now().UnixMilli() - newest
	if age >= 0 && age < 30000 {
		return message
	}
	return ""
}
func (m *Manager) rememberFailure(a Artifact, err error) {
	b, _ := json.Marshal(map[string]any{"at": time.Now().UnixMilli(), "message": err.Error()})
	f, e := os.CreateTemp(m.cacheRoot(), m.key(a)+".failure-*.json")
	if e != nil {
		return
	}
	_, _ = f.Write(b)
	_ = f.Sync()
	_ = f.Close()
}

type downloadFailure struct {
	Message   string
	Retryable bool
}

func (e *downloadFailure) Error() string { return e.Message }
func (m *Manager) download(ctx context.Context, a Artifact, target string) error {
	client := m.Client
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport, CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if r.URL.Scheme != "https" || len(via) > 5 {
				return fmt.Errorf("unsafe runtime download redirect")
			}
			return nil
		}}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Nexo-managed-runtime/1")
	r, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("runtime setup timed out; retry with network access or preseed the verified runtime cache")
		}
		return &downloadFailure{"could not download the pinned Node runtime; check network access, HTTPS_PROXY and certificate settings", ctx.Err() == nil}
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return &downloadFailure{fmt.Sprintf("runtime download returned HTTP %d; retry later or use an offline preseed", r.StatusCode), r.StatusCode == 408 || r.StatusCode >= 500}
	}
	if r.ContentLength > maxArchive {
		return fmt.Errorf("runtime download exceeds size limit")
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r.Body, maxArchive+1))
	if err != nil {
		var fileError *os.PathError
		if errors.As(err, &fileError) {
			return fmt.Errorf("runtime cache write failed: %w", err)
		}
		return &downloadFailure{"runtime download was interrupted; retry setup", ctx.Err() == nil}
	}
	if n > maxArchive {
		return fmt.Errorf("runtime download exceeds size limit")
	}
	if hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return fmt.Errorf("runtime archive checksum mismatch; installation was not activated")
	}
	return f.Sync()
}
func readManifest(file string) (Manifest, error) {
	var m Manifest
	b, e := os.ReadFile(file)
	if e != nil {
		return m, e
	}
	e = json.Unmarshal(b, &m)
	return m, e
}
