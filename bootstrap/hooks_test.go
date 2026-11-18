package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHookProjectionLargeOutput(t *testing.T) {
	input := `{"session_id":"session","cwd":"C:/project","hook_event_name":"PostToolUse","tool_input":{"file_path":"src/wind.ts","command":"` + strings.Repeat("x", 1024*1024) + `"},"tool_response":{"image":"` + strings.Repeat("x", 4*1024*1024) + `"}}`
	output, err := projectHookInput(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if len(output) > 500 {
		t.Fatal("tool output retained")
	}
	var value map[string]any
	if err = json.Unmarshal(output, &value); err != nil {
		t.Fatal(err)
	}
	if value["cwd"] != "C:/project" {
		t.Fatal("metadata lost")
	}
	if _, ok := value["tool_response"]; ok {
		t.Fatal("output retained")
	}
}
func TestRegisteredWorktreeStartsHooksWithoutTrackedBoard(t *testing.T) {
	root := t.TempDir()
	checkout := filepath.Join(root, "checkout")
	gitDir := filepath.Join(root, "metadata")
	os.MkdirAll(checkout, 0700)
	os.MkdirAll(gitDir, 0700)
	if e := os.WriteFile(filepath.Join(checkout, ".git"), []byte("gitdir: "+gitDir+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(gitDir, "nexo-coordinator.json"), []byte(`{"schema":1}`), 0600); e != nil {
		t.Fatal(e)
	}
	if !hasProject(checkout) {
		t.Fatal("registered worktree hook was skipped")
	}
}
func TestHookProjectionMalformed(t *testing.T) {
	for _, v := range []string{`{"cwd":"unfinished`, `{"cwd":`, `{"cwd":123oops}`, `[]`} {
		if _, e := projectHookInput(strings.NewReader(v)); e == nil {
			t.Fatal("malformed hook accepted", v)
		}
	}
}
