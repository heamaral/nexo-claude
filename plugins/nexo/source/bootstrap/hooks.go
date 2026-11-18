package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
)

// Project only lifecycle metadata. Tool results and image payloads are skipped
// byte by byte, with bounded memory regardless of their string length.
func projectHookInput(input io.Reader) ([]byte, error) {
	p := &hookParser{r: bufio.NewReader(io.LimitReader(input, 268435457))}
	value, err := p.object(0, true)
	if err != nil {
		return nil, err
	}
	if _, err = p.next(); err != io.EOF {
		return nil, fmt.Errorf("invalid trailing hook JSON")
	}
	return json.Marshal(value)
}

type hookParser struct {
	r     *bufio.Reader
	count int
}

func (p *hookParser) read() (byte, error) {
	b, e := p.r.ReadByte()
	p.count++
	if p.count > 268435456 {
		return 0, fmt.Errorf("hook exceeds 256 MiB")
	}
	return b, e
}
func (p *hookParser) next() (byte, error) {
	for {
		b, e := p.read()
		if e != nil || (b != ' ' && b != '\n' && b != '\r' && b != '\t') {
			return b, e
		}
	}
}
func (p *hookParser) str(keep bool) ([]byte, error) {
	value := []byte{'"'}
	escaped := false
	for {
		b, e := p.read()
		if e != nil {
			return nil, e
		}
		if b < 32 {
			return nil, fmt.Errorf("invalid hook string")
		}
		if keep {
			value = append(value, b)
			if len(value) > 16384 {
				return nil, fmt.Errorf("hook metadata exceeds limit")
			}
		}
		if escaped {
			escaped = false
			continue
		}
		if b == '\\' {
			escaped = true
			continue
		}
		if b == '"' {
			break
		}
	}
	if keep && !json.Valid(value) {
		return nil, fmt.Errorf("invalid hook string")
	}
	return value, nil
}
func (p *hookParser) value(depth int, keep bool) (json.RawMessage, error) {
	if depth > 128 {
		return nil, fmt.Errorf("hook nesting exceeds limit")
	}
	b, e := p.next()
	if e != nil {
		return nil, e
	}
	if b == '"' {
		v, e := p.str(keep)
		return v, e
	}
	if b == '{' || b == '[' {
		close := byte('}')
		if b == '[' {
			close = ']'
		}
		b, e = p.next()
		if e != nil {
			return nil, e
		}
		if b == close {
			return nil, nil
		}
		p.r.UnreadByte()
		for {
			if close == '}' {
				k, e := p.next()
				if e != nil || k != '"' {
					return nil, fmt.Errorf("invalid hook object")
				}
				if _, e = p.str(false); e != nil {
					return nil, e
				}
				c, e := p.next()
				if e != nil || c != ':' {
					return nil, fmt.Errorf("invalid hook object")
				}
			}
			if _, e = p.value(depth+1, false); e != nil {
				return nil, e
			}
			b, e = p.next()
			if e != nil {
				return nil, e
			}
			if b == close {
				return nil, nil
			}
			if b != ',' {
				return nil, fmt.Errorf("invalid hook container")
			}
		}
	}
	v := []byte{b}
	for {
		b, e = p.read()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		if b == ',' || b == '}' || b == ']' || b == ' ' || b == '\n' || b == '\r' || b == '\t' {
			p.r.UnreadByte()
			break
		}
		v = append(v, b)
		if len(v) > 100 {
			return nil, fmt.Errorf("invalid hook primitive")
		}
	}
	if !json.Valid(v) {
		return nil, fmt.Errorf("invalid hook primitive")
	}
	return v, nil
}
func (p *hookParser) object(depth int, top bool) (map[string]json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	b, e := p.next()
	if e != nil || b != '{' {
		return nil, fmt.Errorf("invalid hook object")
	}
	b, e = p.next()
	if e != nil {
		return nil, e
	}
	if b == '}' {
		return out, nil
	}
	p.r.UnreadByte()
	for {
		b, e = p.next()
		if e != nil || b != '"' {
			return nil, fmt.Errorf("invalid hook key")
		}
		raw, e := p.str(true)
		if e != nil {
			return nil, e
		}
		var key string
		if e = json.Unmarshal(raw, &key); e != nil {
			return nil, e
		}
		b, e = p.next()
		if e != nil || b != ':' {
			return nil, fmt.Errorf("invalid hook object")
		}
		keep := key == "file_path" && !top
		if top {
			switch key {
			case "cwd", "session_id", "agent_id", "hook_event_name", "tool_name", "tool_use_id", "stop_hook_active":
				keep = true
			}
		}
		if top && key == "tool_input" {
			v, e := p.object(depth+1, false)
			if e != nil {
				return nil, e
			}
			out[key], e = json.Marshal(v)
			if e != nil {
				return nil, e
			}
		} else {
			v, e := p.value(depth+1, keep)
			if e != nil {
				return nil, e
			}
			if keep && v != nil {
				out[key] = v
			}
		}
		b, e = p.next()
		if e != nil {
			return nil, e
		}
		if b == '}' {
			return out, nil
		}
		if b != ',' {
			return nil, fmt.Errorf("invalid hook object")
		}
	}
}
