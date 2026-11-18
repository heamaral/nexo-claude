package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Maintainer-only: archives must already have been fetched from the official
// release and the committed archive digests must already be trusted/reviewed.
func TestPinOfficialArtifacts(t *testing.T) {
	dir := os.Getenv("NEXO_PIN_OFFICIAL_ARCHIVES")
	if dir == "" {
		t.Skip("opt-in maintainer pin refresh")
	}
	file := filepath.Join("..", "plugins", "nexo", "bootstrap", "runtime-manifest.json")
	m, err := readManifest(file)
	if err != nil {
		t.Fatal(err)
	}
	for platform, a := range m.Artifacts {
		archive := filepath.Join(dir, filepath.Base(a.URL))
		sum, _, err := fileDigest(archive)
		if err != nil || sum != a.SHA256 {
			t.Fatalf("official archive digest mismatch for %s: %v", platform, err)
		}
		stage := t.TempDir()
		if err = extractRuntime(archive, stage, a); err != nil {
			t.Fatal(platform, err)
		}
		a.BinarySHA256, a.BinarySize, err = fileDigest(filepath.Join(stage, nodeName(platform)))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(a.URL, "https://nodejs.org/dist/v"+m.Version+"/") {
			t.Fatal("unexpected official download URL")
		}
		m.Artifacts[platform] = a
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, append(b, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
