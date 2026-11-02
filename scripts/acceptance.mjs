// Opt-in authenticated smoke test. Never run by the ordinary test suite or CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { initialize } from '../plugins/nexo/runtime/project.mjs';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-acceptance-')),
  plugin = path.resolve('plugins/nexo');
execFileSync('git', ['init', '-q', root]);
fs.writeFileSync(path.join(root, 'README.txt'), 'Nexo isolated integration fixture\n');
execFileSync('git', ['-C', root, 'add', 'README.txt']);
execFileSync('git', [
  '-C',
  root,
  '-c',
  'user.name=Nexo Test',
  '-c',
  'user.email=test@localhost',
  'commit',
  '-qm',
  'Fixture',
]);
const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
initialize(root, 'Nexo acceptance');
const service = await startServer(root),
  observed = [];
service.store.onChange = () => {
  observed.push({
    at: Date.now(),
    agents: service.store.agents().map(({ token, ...a }) => a),
    tasks: service.store.all('task').map((t) => ({ id: t.id, stage: t.data.stageId })),
    deliveries: service.store.all('delivery').map((d) => ({ id: d.id, status: d.data.status })),
  });
};
const cli =
  process.env.NEXO_CLAUDE_BIN ??
  path.resolve('node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const session = crypto.randomUUID();
const prompt = `This is an authorized isolated Nexo plugin integration smoke test. No source changes or shell tools are needed. Use only Nexo MCP and the native Agent tool. Do not use other MCP servers. Fixture commit: ${sha}.
Read state. Create delivery id=smoke, title=Integration smoke, workflow=[{id:todo,name:Planned,phase:queued},{id:doing,name:Working,phase:active},{id:done,name:Done,phase:done}]. Create team id=smoke-team deliveryId=smoke title=Smoke team. Create planning task id=smoke-plan stageId=todo and work task id=smoke-work stageId=todo, both in smoke and team smoke-team; work depends on smoke-plan. Claim smoke-plan as reviewer using YOUR OWN native agentId/sessionId provided by hook, name=Native planner, scopes=[.], teamId=smoke-team, ttlSeconds=600. Register result and evidence with the given real commit; move it to done with leaseToken and current expectedVersion; release. Delegate smoke-work to native Agent subagent_type=nexo:worker (if plugin uses another advertised name use it), explicitly instructing it to use its own hook agentId/sessionId, teamId=smoke-team, name=Native worker, scopes=[fixture], ttlSeconds=600, claim executor, read state, register result and evidence that MCP round-trip succeeded, move to done with leaseToken and expectedVersion, release. After worker returns, verify both done and no active agents; accept smoke delivery with result=Native plugin lifecycle validated. Do not invent IDs or evidence. If anything fails, report exact error and do not pretend success. Final answer should only summarize test results.`;
const child = spawn(
  cli,
  [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--session-id',
    session,
    '--plugin-dir',
    plugin,
    '--agent',
    'nexo:planner',
    '--setting-sources',
    'project',
    '--allowedTools',
    'mcp__plugin_nexo_nexo__*,Agent',
    '--max-budget-usd',
    '3',
  ],
  {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      NEXO_PROJECT_ROOT: root,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
child.stdin.end(prompt);
let output = '',
  errors = '';
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (errors += c));
const timeout = setTimeout(() => child.kill(), 240000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  clearTimeout(timeout);
  const state = service.store.state(),
    passed =
      code === 0 &&
      state.entities.find((e) => e.id === 'smoke')?.data.status === 'accepted' &&
      observed.some((s) => s.agents.some((a) => a.name === 'Native worker')) &&
      observed.some((s) => s.agents.some((a) => a.name === 'Native planner')) &&
      !state.agents.some((a) => a.state === 'working');
  fs.mkdirSync('../../work/acceptance', { recursive: true });
  fs.writeFileSync('../../work/acceptance/claude-stream.jsonl', output);
  fs.writeFileSync('../../work/acceptance/stderr.log', errors);
  fs.writeFileSync('../../work/acceptance/observed.json', JSON.stringify(observed, null, 2));
  console.log(
    JSON.stringify(
      {
        passed,
        code,
        root,
        session,
        state,
        observations: observed.length,
        lastOutput: output.slice(-7000),
        errors: errors.slice(-2000),
      },
      null,
      2,
    ),
  );
  process.exitCode = passed ? 0 : 1;
} finally {
  clearTimeout(timeout);
  await service.close();
}
