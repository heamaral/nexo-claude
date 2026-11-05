package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type rpc struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}
type frame struct {
	data []byte
	err  error
}

func frames(ctx context.Context, r io.Reader) <-chan frame {
	out := make(chan frame)
	go func() {
		defer close(out)
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 4096), 32<<20)
		for s.Scan() {
			b := append([]byte(nil), s.Bytes()...)
			select {
			case out <- frame{data: b}:
			case <-ctx.Done():
				return
			}
		}
		if e := s.Err(); e != nil {
			select {
			case out <- frame{err: e}:
			case <-ctx.Done():
			}
		}
	}()
	return out
}

// The native bootstrap answers MCP initialization immediately. While Node is
// preparing, tools/list exposes runtime_status, and regular requests are queued
// with bounded memory. Once the real SDK server is ready, list_changed triggers
// normal discovery. All application operations still run in the existing server.
func bridge(ctx context.Context, m *Manager, root string, in io.Reader, out, logs io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var writeMu sync.Mutex
	write := func(v any) error { writeMu.Lock(); defer writeMu.Unlock(); return json.NewEncoder(out).Encode(v) }
	response := func(id json.RawMessage, result any) error {
		return write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	failure := func(id json.RawMessage, code int, message string) error {
		if len(id) == 0 {
			return nil
		}
		return write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
	}
	statusTool := map[string]any{"name": "runtime_status", "description": "Read Nexo private runtime preparation status. Installation starts automatically; no global Node or PATH changes are made. If preparation fails, report the diagnostic and retry the MCP connection or run the Nexo launcher setup command.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}, "annotations": map[string]any{"readOnlyHint": true, "idempotentHint": true}}
	setup := make(chan struct {
		node string
		err  error
	}, 1)
	go func() {
		setupCtx, c := context.WithTimeout(ctx, 90*time.Second)
		defer c()
		node, err := m.Ensure(setupCtx)
		setup <- struct {
			node string
			err  error
		}{node, err}
	}()
	client := frames(ctx, in)
	var childFrames <-chan frame
	var child *exec.Cmd
	var childInput io.WriteCloser
	defer func() {
		if childInput != nil {
			_ = childInput.Close()
		}
		if child != nil && child.Process != nil {
			done := make(chan error, 1)
			go func() { done <- child.Wait() }()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				_ = child.Process.Kill()
				<-done
			}
		}
	}()
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	privateID := "nexo-bootstrap-" + hex.EncodeToString(nonce[:])
	privateJSON, _ := json.Marshal(privateID)
	var initialized, clientReady, ready bool
	var node string
	var initParams map[string]any
	var setupErr error
	queue := []rpc{}
	queuedBytes := 0
	listIDs := map[string]bool{}
	forward := func(message rpc) error {
		if message.Method == "tools/list" {
			listIDs[string(message.ID)] = true
		}
		return json.NewEncoder(childInput).Encode(message)
	}
	start := func() error {
		if node == "" || !initialized || !clientReady || child != nil {
			return nil
		}
		child = exec.CommandContext(ctx, node, "--disable-warning=ExperimentalWarning", filepath.Join(root, "runtime", "mcp.mjs"))
		child.Env = cleanNodeEnv()
		child.Stderr = logs
		hideWindow(child)
		var err error
		childInput, err = child.StdinPipe()
		if err != nil {
			return err
		}
		stdout, err := child.StdoutPipe()
		if err != nil {
			return err
		}
		if err = child.Start(); err != nil {
			child = nil
			return err
		}
		childFrames = frames(ctx, stdout)
		return json.NewEncoder(childInput).Encode(map[string]any{"jsonrpc": "2.0", "id": privateID, "method": "initialize", "params": initParams})
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case result := <-setup:
			setup = nil
			node, setupErr = result.node, result.err
			if setupErr != nil {
				fmt.Fprintln(logs, "Nexo runtime setup:", setupErr)
				for _, q := range queue {
					if err := failure(q.ID, -32002, "Nexo runtime preparation failed: "+setupErr.Error()); err != nil {
						return err
					}
				}
				queue = nil
				queuedBytes = 0
			} else if err := start(); err != nil {
				return err
			}
		case f, ok := <-client:
			if !ok {
				return nil
			}
			if f.err != nil {
				return f.err
			}
			var q rpc
			if json.Unmarshal(f.data, &q) != nil {
				if err := failure(json.RawMessage("null"), -32700, "Invalid JSON-RPC frame"); err != nil {
					return err
				}
				continue
			}
			if q.Version != "2.0" {
				if err := failure(json.RawMessage("null"), -32600, "Invalid JSON-RPC version"); err != nil {
					return err
				}
				continue
			}
			if q.Method == "initialize" {
				if initialized {
					if err := failure(q.ID, -32600, "Already initialized"); err != nil {
						return err
					}
					continue
				}
				if err := json.Unmarshal(q.Params, &initParams); err != nil || initParams == nil {
					if err := failure(q.ID, -32602, "Invalid initialization parameters"); err != nil {
						return err
					}
					continue
				}
				if len(m.Manifest.Protocols) == 0 {
					return fmt.Errorf("missing supported MCP protocol versions")
				}
				protocol := m.Manifest.Protocols[0]
				for _, v := range m.Manifest.Protocols {
					if initParams["protocolVersion"] == v {
						protocol = v
						break
					}
				}
				initParams["protocolVersion"] = protocol
				initialized = true
				if err := response(q.ID, map[string]any{"protocolVersion": protocol, "capabilities": map[string]any{"tools": map[string]any{"listChanged": true}}, "serverInfo": map[string]any{"name": "nexo", "version": m.Manifest.ApplicationVersion}}); err != nil {
					return err
				}
				if err := start(); err != nil {
					return err
				}
				continue
			}
			if !initialized {
				if err := failure(q.ID, -32000, "Initialize the MCP server first"); err != nil {
					return err
				}
				continue
			}
			if q.Method == "notifications/initialized" {
				clientReady = true
				if err := start(); err != nil {
					return err
				}
				continue
			}
			if q.Method == "ping" {
				if err := response(q.ID, map[string]any{}); err != nil {
					return err
				}
				continue
			}
			if q.Method == "tools/call" {
				var p struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(q.Params, &p)
				if p.Name == "runtime_status" {
					state, _ := json.Marshal(m.State())
					if err := response(q.ID, map[string]any{"content": []any{map[string]any{"type": "text", "text": string(state)}}}); err != nil {
						return err
					}
					continue
				}
			}
			if ready {
				if len(listIDs) > 128 {
					return fmt.Errorf("too many outstanding tool discovery requests")
				}
				if err := forward(q); err != nil {
					return err
				}
				continue
			}
			if q.Method == "tools/list" {
				if err := response(q.ID, map[string]any{"tools": []any{statusTool}}); err != nil {
					return err
				}
				continue
			}
			if setupErr != nil {
				if err := failure(q.ID, -32002, "Nexo runtime preparation failed: "+setupErr.Error()); err != nil {
					return err
				}
				continue
			}
			if len(queue) >= 128 || queuedBytes+len(f.data) > 4<<20 {
				if err := failure(q.ID, -32002, "Nexo is preparing its runtime; retry this request shortly"); err != nil {
					return err
				}
				continue
			}
			queue = append(queue, q)
			queuedBytes += len(f.data)
		case f, ok := <-childFrames:
			if !ok {
				return fmt.Errorf("the Nexo MCP process exited; check runtime_status and reconnect")
			}
			if f.err != nil {
				return f.err
			}
			var q rpc
			if err := json.Unmarshal(f.data, &q); err != nil {
				return fmt.Errorf("invalid frame from bundled MCP server")
			}
			if string(q.ID) == string(privateJSON) {
				if len(q.Error) != 0 {
					return fmt.Errorf("bundled MCP initialization failed")
				}
				if err := json.NewEncoder(childInput).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
					return err
				}
				ready = true
				if err := write(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}); err != nil {
					return err
				}
				for _, pending := range queue {
					if err := forward(pending); err != nil {
						return err
					}
				}
				queue = nil
				queuedBytes = 0
				continue
			}
			if listIDs[string(q.ID)] {
				delete(listIDs, string(q.ID))
				if len(q.Error) == 0 {
					var result map[string]json.RawMessage
					if err := json.Unmarshal(q.Result, &result); err != nil {
						return err
					}
					var tools []any
					if err := json.Unmarshal(result["tools"], &tools); err != nil {
						return err
					}
					tools = append(tools, statusTool)
					result["tools"], _ = json.Marshal(tools)
					q.Result, _ = json.Marshal(result)
				}
			}
			if err := write(q); err != nil {
				return err
			}
		}
	}
}
