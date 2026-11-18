package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestMCPRespondsDuringSetupAndDiscoversApplicationTools(t *testing.T) {
	node := os.Getenv("NEXO_TEST_NODE")
	if node == "" {
		var e error
		node, e = exec.LookPath("node")
		if e != nil {
			t.Skip("integration needs the developer Node test runner")
		}
	}
	root, err := filepath.Abs(filepath.Join("..", "plugins", "nexo"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := readManifest(filepath.Join(root, "bootstrap", "runtime-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	started := make(chan struct{})
	m := &Manager{Manifest: manifest, Data: t.TempDir(), Platform: nativePlatform(), Override: node, Log: io.Discard, Check: func(ctx context.Context, node, version string) error {
		close(started)
		select {
		case <-gate:
			return probe(ctx, node, version)
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	clientRead, clientWrite := io.Pipe()
	serverRead, serverWrite := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- bridge(ctx, m, root, clientRead, serverWrite, io.Discard); _ = serverWrite.Close() }()
	defer func() {
		_ = clientWrite.Close()
		_ = serverRead.Close()
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("MCP bootstrap did not close its child")
		}
	}()
	input := json.NewEncoder(clientWrite)
	messages := make(chan rpc, 32)
	go func() {
		defer close(messages)
		s := bufio.NewScanner(serverRead)
		s.Buffer(make([]byte, 4096), 4<<20)
		for s.Scan() {
			var q rpc
			if json.Unmarshal(s.Bytes(), &q) == nil {
				messages <- q
			}
		}
	}()
	read := func() rpc {
		t.Helper()
		select {
		case q, ok := <-messages:
			if !ok {
				t.Fatal("MCP stream ended")
			}
			return q
		case <-time.After(10 * time.Second):
			t.Fatal("MCP response timed out")
			return rpc{}
		}
	}
	<-started
	for _, invalid := range []string{
		"{invalid JSON\n",
		"{\"jsonrpc\":\"1.0\",\"id\":0,\"method\":\"initialize\"}\n",
		"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":null}\n",
	} {
		if _, err := io.WriteString(clientWrite, invalid); err != nil {
			t.Fatal(err)
		}
		if q := read(); len(q.Error) == 0 {
			t.Fatal("invalid initialization was accepted", q)
		}
	}
	before := time.Now()
	if err = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": manifest.Protocols[0], "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "native-bootstrap-test", "version": "1"}}}); err != nil {
		t.Fatal(err)
	}
	init := read()
	if string(init.ID) != "1" || len(init.Error) != 0 || time.Since(before) > 2*time.Second {
		t.Fatal("runtime download blocked MCP initialization", init)
	}
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	list := read()
	var initial struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err = json.Unmarshal(list.Result, &initial); err != nil || len(initial.Tools) != 1 || initial.Tools[0].Name != "runtime_status" {
		t.Fatal("missing first-run diagnostic tool", string(list.Result), err)
	}
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{"name": "runtime_status", "arguments": map[string]any{}}})
	status := read()
	if len(status.Error) != 0 || string(status.ID) != "3" {
		t.Fatal("status was not available during setup")
	}
	// This application request is accepted while setup is pending, then forwarded
	// exactly once to the SDK server after the native handshake finishes.
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{"name": "command", "arguments": map[string]any{"op": "remove-everything"}}})
	close(gate)
	// Even if the runtime finishes first, application discovery must wait for
	// the client's initialization notification, as required by MCP lifecycle.
	deadline := time.Now().Add(10 * time.Second)
	for m.State().Status != "ready" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 6, "method": "ping"})
	if q := read(); string(q.ID) != "6" {
		t.Fatal("application notification preceded client initialization", q)
	}
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	changed := false
	answered := false
	for !changed || !answered {
		q := read()
		if q.Method == "notifications/tools/list_changed" {
			changed = true
		}
		if string(q.ID) == "4" {
			var r struct {
				IsError bool `json:"isError"`
			}
			if json.Unmarshal(q.Result, &r) != nil || !r.IsError {
				t.Fatal("queued mutation bypassed application input validation", string(q.Result))
			}
			answered = true
		}
	}
	_ = input.Encode(map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
	q := read()
	var final struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err = json.Unmarshal(q.Result, &final); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range final.Tools {
		names[tool.Name] = true
	}
	if !names["claim"] || !names["board_open"] || !names["runtime_status"] {
		t.Fatal("application tools were not discovered", names)
	}
}

func TestMCPSetupFailureRemainsDiagnosable(t *testing.T) {
	manifest := Manifest{Version: "24.22.1", ApplicationVersion: "test", Protocols: []string{"2025-11-25"}, Artifacts: map[string]Artifact{}}
	m := &Manager{Manifest: manifest, Platform: "unsupported-test-platform", Data: t.TempDir(), Log: io.Discard}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	ctx, c := context.WithCancel(context.Background())
	defer c()
	done := make(chan error, 1)
	go func() { done <- bridge(ctx, m, t.TempDir(), inR, outW, io.Discard); _ = outW.Close() }()
	defer func() { _ = inW.Close(); _ = outR.Close(); c(); <-done }()
	enc := json.NewEncoder(inW)
	dec := json.NewDecoder(outR)
	_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "1"}}})
	var q rpc
	if err := dec.Decode(&q); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for m.State().Status != "error" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "runtime_status", "arguments": map[string]any{}}})
	if err := dec.Decode(&q); err != nil {
		t.Fatal(err)
	}
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(q.Result, &r) != nil || len(r.Content) != 1 {
		t.Fatal("missing runtime status")
	}
	var state RuntimeState
	if json.Unmarshal([]byte(r.Content[0].Text), &state) != nil || state.Status != "error" || state.Error == "" {
		t.Fatal("setup error was hidden", r)
	}
}
