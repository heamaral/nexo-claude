// Opt-in authenticated helper/worktree test, outside ordinary CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { initialize } from '../plugins/nexo/runtime/project.mjs';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-parallel-')),
  root = path.join(base, 'main');
fs.mkdirSync(root);
execFileSync('git', ['init', '-q', root]);
fs.writeFileSync(path.join(root, 'README.txt'), 'Parallel fixture\n');
execFileSync('git', ['-C', root, 'add', '.']);
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
initialize(root, 'Parallel acceptance');
const service = await startServer(root);
let maxActive = 0;
const changed = service.store.onChange;
service.store.onChange = () => {
  maxActive = Math.max(
    maxActive,
    service.store.agents().filter((a) => a.state === 'working').length,
  );
  changed();
};
const command = (kind, id, data) =>
  service.store.execute({
    commandId: crypto.randomUUID(),
    actor: 'fixture',
    op: 'create',
    kind,
    id,
    expectedVersion: 0,
    data,
  });
command('delivery', 'parallel', {
  title: 'Parallel validation',
  workflow: [
    { id: 'backlog', name: 'Planned', phase: 'queued' },
    { id: 'doing', name: 'Working', phase: 'active' },
    { id: 'done', name: 'Done', phase: 'done' },
  ],
});
const jobs = ['backend', 'frontend'].map((team) => {
  const workspace = path.join(base, team);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', team, workspace]);
  command('team', team, {
    deliveryId: 'parallel',
    title: team,
    workspace,
    engine: 'independent-session',
  });
  command('task', team + '-task', {
    deliveryId: 'parallel',
    teamId: team,
    title: 'Validate ' + team,
  });
  const prompt = path.join(base, team + '.txt');
  fs.writeFileSync(
    prompt,
    `Authorized isolated integration test. Use only Nexo MCP tools. Your lease and native IDs are provided above. Read state from the coordinator and verify you see both teams. Do not claim again, edit files, launch agents or run shell. Complete your assigned ${team}-task with result='Independent worktree session validated', evidence=[{label:'MCP coordinator state observed from independent worktree',commit:'${sha}'}], stageId=done, using YOUR existing leaseToken and the current expectedVersion from state. Release your lease and return a concise success message.`,
  );
  return { team, workspace, prompt };
});
const cli = path.resolve('plugins/nexo/runtime/cli.mjs'),
  native =
    process.env.NEXO_CLAUDE_BIN ??
    path.resolve('node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const children = [];
try {
  const results = await Promise.all(
    jobs.map(async (j) => {
      const child = spawn(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          cli,
          'run',
          '--project',
          root,
          '--workspace',
          j.workspace,
          '--task',
          j.team + '-task',
          '--team',
          j.team,
          '--scope',
          j.team,
          '--prompt-file',
          j.prompt,
          '--max-budget-usd',
          '1',
        ],
        {
          cwd: root,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
            NEXO_CLAUDE_BIN: native,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let output = '',
        error = '';
      child.stdout.on('data', (c) => (output += c));
      child.stderr.on('data', (c) => (error += c));
      const timeout = setTimeout(() => child.kill(), 180000);
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      clearTimeout(timeout);
      fs.mkdirSync('../../work/acceptance', { recursive: true });
      fs.writeFileSync('../../work/acceptance/' + j.team + '.jsonl', output);
      return { team: j.team, code, error, lastOutput: output.slice(-1200) };
    }),
  );
  const state = service.store.state();
  const passed =
    results.every((r) => r.code === 0) &&
    state.entities.filter((e) => e.kind === 'task').every((e) => e.data.stageId === 'done') &&
    !state.agents.some((a) => a.state === 'working') &&
    maxActive >= 2;
  console.log(JSON.stringify({ passed, maxActive, root, results, state }, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await service.close();
}
