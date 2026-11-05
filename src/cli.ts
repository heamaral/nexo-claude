#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProject, initialize, loadConfig } from './project.js';
import { ensureServer, request, board } from './client.js';
import { startServer } from './server.js';

async function main() {
  const [action = 'help', ...args] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const cwd =
    flag('--project') ??
    process.env.NEXO_PROJECT_ROOT ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error(
      'Nexo requires Node.js 24.22.x (LTS). Install this runtime and check the Claude PATH.',
    );
  if (action === 'serve') {
    const running = await startServer(findProject(cwd));
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void running.close().then(() => process.exit(0)));
    return;
  }
  if (action === 'init') {
    const result = initialize(cwd, flag('--name'), { exact: args.includes('--here') });
    await ensureServer(result.root);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'board') {
    console.log(
      JSON.stringify(await board(findProject(cwd), !args.includes('--no-open')), null, 2),
    );
    return;
  }
  if (action === 'snapshot') {
    console.log(JSON.stringify(await request('snapshot', {}, findProject(cwd))));
    return;
  }
  if (action === 'stop') {
    console.log(JSON.stringify(await request('shutdown', {}, findProject(cwd))));
    return;
  }
  if (action === 'run') {
    const root = findProject(cwd),
      workspace = fs.realpathSync(flag('--workspace') ?? root),
      taskId = flag('--task'),
      promptFile = flag('--prompt-file');
    if (!taskId || !promptFile)
      throw new Error(
        'run requires --task <id> --prompt-file <file> --scope <relative-path> [--workspace <worktree>]',
      );
    const prompt = fs.readFileSync(promptFile, 'utf8');
    if (prompt.length > 100000) throw new Error('Prompt exceeds 100 KiB');
    const scopes = (flag('--scope') ?? '').split(',').filter(Boolean);
    if (!scopes.length) throw new Error('Provide explicit write scopes with --scope');
    const budget = Number(flag('--max-budget-usd') ?? 10);
    if (!Number.isFinite(budget) || budget <= 0 || budget > 1000)
      throw new Error('Budget must be greater than 0 and at most 1000 USD');
    const sessionId = crypto.randomUUID();
    const actor = await request(
      'claim',
      {
        taskId,
        agentId: sessionId,
        sessionId,
        name: flag('--name') ?? 'Independent session',
        teamId: flag('--team'),
        scopes,
        ttlSeconds: 600,
      },
      root,
    );
    const runtime = path.dirname(fileURLToPath(import.meta.url)),
      plugin = path.dirname(runtime);
    const child = spawn(
      process.env.NEXO_CLAUDE_BIN ?? 'claude',
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--session-id',
        sessionId,
        '--plugin-dir',
        plugin,
        '--agent',
        'nexo:worker',
        '--allowedTools',
        'mcp__plugin_nexo_nexo__*',
        '--max-budget-usd',
        String(budget),
      ],
      {
        cwd: workspace,
        windowsHide: true,
        env: { ...process.env, NEXO_PROJECT_ROOT: root, NEXO_WORKSPACE: workspace },
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    child.stdin?.end(
      `Nexo: taskId=${taskId}; teamId=${flag('--team') ?? ''}; agentId=${sessionId}; sessionId=${sessionId}. A lease has already been acquired for you: leaseToken=${actor.token}. Do not claim again; use heartbeat and command with this lease. Workspace=${workspace}.\n\n${prompt}`,
    );
    const cleanup = () => request('release', { token: actor.token }, root).catch(() => {});
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => child.kill(signal));
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
      process.exitCode = code;
    } finally {
      await cleanup();
    }
    return;
  }
  if (action === 'doctor') {
    const root = findProject(cwd),
      config = loadConfig(root),
      state = await request('state', undefined, root);
    console.log(
      JSON.stringify(
        {
          root,
          node: process.version,
          project: config,
          healthError: state.healthError,
          runtimeVersion: state.runtimeVersion,
          snapshot: state.snapshot,
          conflicts: state.conflicts,
          eventCount: state.eventCount,
          agents: state.agents,
          checks: {
            loopback: true,
            exclusiveWriter: true,
            sqliteSnapshot: fs.existsSync(path.join(root, '.nexo', 'project.sqlite')),
            projectAlias: fs.existsSync(path.join(root, '.claude', 'commands', 'board.md')),
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === 'resolve') {
    const ids = args.filter((a) => !a.startsWith('--') && a !== flag('--project'));
    console.log(JSON.stringify(await request('resolve', { eventIds: ids }, findProject(cwd))));
    return;
  }
  if (action === 'hook') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      size += c.length;
      if (size > 262144) throw new Error('Hook input exceeded the size limit');
      chunks.push(c);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let root: string;
    try {
      root = findProject(process.env.NEXO_PROJECT_ROOT ?? input.cwd ?? cwd);
    } catch {
      return;
    }
    const agentId = input.agent_id ?? input.session_id,
      sessionId = input.session_id,
      event = input.hook_event_name;
    if (['SessionStart', 'SubagentStart'].includes(event)) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: `Nexo is enabled for this project. Your identity: agentId=${agentId}; sessionId=${sessionId}. Read state and claim your card using these IDs before writing or running shell tools. Record results and evidence before completion; heartbeat renews the lease and release ends participation. Use nexo:planner to organize deliveries, teams, hierarchy and dependencies through MCP. /board opens the live board. Respond in the user's language and preserve the language of project content.`,
          },
        }),
      );
      return;
    }
    await request(
      'hook',
      {
        sessionId,
        agentId,
        event,
        toolName: input.tool_name,
        filePath: input.tool_input?.file_path,
        workspace: process.env.NEXO_WORKSPACE ?? input.cwd,
      },
      root,
    );
    return;
  }
  console.log(
    'Nexo · init | board [--no-open] | doctor | snapshot | resolve <event-id>\nUse --project <directory> to select the project.',
  );
}
main().catch((e) => {
  console.error(`Nexo: ${e.message}`);
  process.exitCode = process.argv[2] === 'hook' ? 2 : 1;
});
