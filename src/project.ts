import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { assert } from './model.js';

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    maxAgents: z.number().int().min(1).max(128),
    maxTeamsPerDelivery: z.number().int().min(1).max(32),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function atomicWrite(file: string, data: string | Buffer, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}
export function findProject(cwd = process.cwd()): string {
  let current = fs.realpathSync.native(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, '.nexo', 'project.json'))) return current;
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  throw new Error('Projeto não inicializado. Execute /nexo:init neste diretório.');
}
export function loadConfig(root: string): Config {
  const dir = path.join(root, '.nexo');
  assert(
    !fs.lstatSync(dir).isSymbolicLink(),
    'UNSAFE_PATH',
    '.nexo não pode ser um link simbólico',
    400,
  );
  return configSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')));
}
export function initialize(cwd = process.cwd(), name?: string, options: { exact?: boolean } = {}) {
  let root = fs.realpathSync.native(cwd);
  // Initialize the current repository, but preserve explicit nested project directories.
  if (!options.exact)
    try {
      root = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
    } catch {}
  root = fs.realpathSync.native(root);
  const dir = path.join(root, '.nexo');
  if (fs.existsSync(path.join(dir, 'project.json')))
    return { root, config: loadConfig(root), created: false };
  fs.mkdirSync(dir, { recursive: true });
  assert(
    !fs.lstatSync(dir).isSymbolicLink(),
    'UNSAFE_PATH',
    '.nexo não pode ser um link simbólico',
    400,
  );
  const config: Config = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: name ?? path.basename(root),
    maxAgents: 8,
    maxTeamsPerDelivery: 3,
  };
  // Exclusive creation prevents two sessions from assigning different project identities.
  const fd = fs.openSync(path.join(dir, 'project.json'), 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!fs.existsSync(path.join(dir, '.gitignore')))
    atomicWrite(path.join(dir, '.gitignore'), 'local/\n*.tmp\n');
  atomicWrite(
    path.join(dir, '.gitattributes'),
    'project.sqlite binary\nevents/*.json text eol=lf\n',
  );
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  const command = path.join(root, '.claude', 'commands', 'board.md');
  if (!fs.existsSync(command))
    atomicWrite(
      command,
      "---\ndescription: Open the live Nexo board for this project\n---\nInvoke the `nexo:board` skill for the current project. Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.\n",
    );
  const rule = path.join(root, '.claude', 'rules', 'nexo.md');
  if (!fs.existsSync(rule))
    atomicWrite(
      rule,
      "# Nexo\n\nThis project uses `.nexo/` as its delivery record. Read Nexo MCP state before starting work.\nUse `nexo:planner` to organize new implementation requests before execution.\nNew requests after an accepted delivery create a new delivery. Preserve accepted history.\nModel hierarchy and execution dependencies separately. Never complete cards without evidence.\nBefore delegating, associate each agent with its card and team, declare write scopes and acquire a lease.\nRenew leases during work and release them when finished. A subagent response does not prove task completion.\nUse separate worktrees for teams writing in parallel. Validate the integrated commit before acceptance.\nDo not edit SQLite or events manually. Use MCP and `/nexo:board` to inspect progress.\n\n## Language\n\nTechnical instructions use English. Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.\n",
    );
  return { root, config, created: true };
}
export function localDir(root: string) {
  const dir = path.join(root, '.nexo', 'local');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assert(
    !fs.lstatSync(dir).isSymbolicLink(),
    'UNSAFE_PATH',
    'local não pode ser link simbólico',
    400,
  );
  return dir;
}
export function safeEventsDir(root: string) {
  const dir = path.join(root, '.nexo', 'events');
  fs.mkdirSync(dir, { recursive: true });
  assert(
    !fs.lstatSync(dir).isSymbolicLink(),
    'UNSAFE_PATH',
    'events não pode ser link simbólico',
    400,
  );
  return dir;
}
