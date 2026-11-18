/** Streaming JSON projection: discarded tool output is never buffered. */
export async function readHookInput(input: AsyncIterable<Buffer | string>) {
  const wanted = new Set([
    'session_id',
    'agent_id',
    'cwd',
    'hook_event_name',
    'tool_name',
    'tool_use_id',
    'stop_hook_active',
    'tool_input.file_path',
  ]);
  const result: any = {};
  type Frame = { path: string; type: string; phase: string; key: string };
  const stack: Frame[] = [];
  let token = '',
    string = false,
    escaped = false,
    primitive = false,
    capture = false,
    total = 0,
    started = false,
    ended = false;
  const target = () => {
    const f = stack.at(-1);
    return f ? [f.path, f.type === '{' ? f.key : '*'].filter(Boolean).join('.') : '';
  };
  const complete = () => {
    const f = stack.at(-1);
    if (f) f.phase = 'comma';
    else ended = true;
  };
  const consume = (value: string, scalar = false) => {
    const f = stack.at(-1);
    if (scalar && f?.phase === 'key') {
      f.key = JSON.parse(value);
      f.phase = 'colon';
      return;
    }
    if (value === ':' && f?.phase === 'colon') {
      f.phase = 'value';
      return;
    }
    if (value === ',' && f?.phase === 'comma') {
      f.phase = f.type === '{' ? 'key' : 'value';
      return;
    }
    if (
      (value === '}' || value === ']') &&
      f &&
      ((f.type === '{' && value === '}') || (f.type === '[' && value === ']')) &&
      ['comma', 'key', 'value'].includes(f.phase)
    ) {
      stack.pop();
      complete();
      return;
    }
    if (ended || (f && f.phase !== 'value') || (!f && started))
      throw new Error('Invalid hook JSON');
    const key = target();
    started = true;
    if (!scalar && (value === '{' || value === '[')) {
      if (stack.length >= 128) throw new Error('Hook JSON nesting exceeds limit');
      stack.push({ path: key, type: value, phase: value === '{' ? 'key' : 'value', key: '' });
      return;
    }
    if (!scalar) throw new Error('Invalid hook JSON');
    if (wanted.has(key)) {
      const parsed = JSON.parse(value);
      if (key === 'tool_input.file_path') result.tool_input = { file_path: parsed };
      else result[key] = parsed;
    }
    complete();
  };
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 268435456) throw new Error('Hook input exceeds 256 MiB');
    for (const byte of bytes) {
      const c = String.fromCharCode(byte);
      if (string) {
        if (capture) {
          token += c;
          if (token.length > 16384) throw new Error('Hook metadata exceeds limit');
        }
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === '\\') {
          escaped = true;
          continue;
        }
        if (c === '"') {
          string = false;
          consume(capture ? Buffer.from(token, 'latin1').toString('utf8') : 'null', true);
          token = '';
        }
        continue;
      }
      if (primitive && !/[\s,\]}]/.test(c)) {
        token += c;
        if (token.length > 100) throw new Error('Invalid JSON primitive');
        continue;
      }
      if (primitive) {
        JSON.parse(token);
        consume(token, true);
        token = '';
        primitive = false;
      }
      if (/\s/.test(c)) continue;
      if (c === '"') {
        string = true;
        capture = stack.at(-1)?.phase === 'key' || wanted.has(target());
        token = capture ? '"' : '';
      } else if ('{}[]:,'.includes(c)) consume(c);
      else {
        primitive = true;
        token = c;
      }
    }
  }
  if (primitive) {
    JSON.parse(token);
    consume(token, true);
  }
  if (string || stack.length || !ended || !started) throw new Error('Incomplete hook JSON');
  return result;
}
