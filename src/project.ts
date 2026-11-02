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
      '---\ndescription: Abrir o board Nexo deste projeto\n---\nExecute a skill `nexo:board` para abrir o board do projeto atual.\n',
    );
  const rule = path.join(root, '.claude', 'rules', 'nexo.md');
  if (!fs.existsSync(rule))
    atomicWrite(
      rule,
      '# Nexo\n\nEste projeto usa `.nexo/` como registro de entregas. Consulte as ferramentas MCP Nexo antes de iniciar trabalho.\nNovos pedidos após uma entrega aceita criam outra entrega. Preserve o histórico.\nPlaneje hierarquia e dependências separadamente. Nunca conclua cards sem evidência.\nAntes de delegar, associe cada agente ao card e ao time, registre os escopos de escrita e obtenha uma lease.\nRenove a lease durante o trabalho; libere ao terminar. Uma resposta de subagente não prova conclusão do card.\nUse worktrees distintos para times que escrevem em paralelo. Teste a versão integrada antes da aceitação.\nNão edite o SQLite nem os eventos manualmente. Use o MCP e execute `/nexo:board` para acompanhar.\n',
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
