import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize } from '../plugins/nexo/runtime/project.mjs';
import { Store } from '../plugins/nexo/runtime/store.mjs';
export function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-test-')));
  initialize(root, 'Nexo Workspace');
  const store = new Store(root);
  return {
    root,
    store,
    close() {
      store.close();
      if (
        !path.basename(root).startsWith('nexo-test-') ||
        path.dirname(root) !== fs.realpathSync.native(os.tmpdir())
      )
        throw new Error('Unsafe cleanup');
      // The detached fixture can have closed its registry/database just before
      // Windows releases its cwd handle. Cleanup waits briefly for process exit.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
export function command(store, kind, id, data = {}, op = 'create', extra = {}) {
  return store.execute({
    commandId: crypto.randomUUID(),
    actor: 'test',
    kind,
    id,
    op,
    expectedVersion: store.get(id)?.version ?? 0,
    data,
    ...extra,
  });
}
export function seed(store) {
  command(store, 'delivery', 'delivery', {
    title: 'Recuperação de senha',
    description: 'Tokens seguros, e-mail e experiência de recuperação.',
  });
  command(store, 'team', 'backend', {
    deliveryId: 'delivery',
    title: 'Backend',
    description: 'API e tokens de uso único',
    maxAgents: 3,
  });
  command(store, 'team', 'frontend', {
    deliveryId: 'delivery',
    title: 'Frontend',
    description: 'Interface acessível de nova senha',
    maxAgents: 3,
  });
  command(store, 'task', 'tokens', {
    deliveryId: 'delivery',
    teamId: 'backend',
    title: 'Tokens de uso único',
    criteria: ['Token expira e não pode ser reutilizado'],
  });
  command(store, 'task', 'form', {
    deliveryId: 'delivery',
    teamId: 'frontend',
    title: 'Formulário de nova senha',
    criteria: ['Teclado e leitores de tela atendidos'],
  });
  command(store, 'task', 'integrate', {
    deliveryId: 'delivery',
    title: 'Integrar e validar',
    dependencies: ['tokens', 'form'],
    criteria: ['Validar o mesmo commit integrado'],
  });
}
export const claim = (taskId = 'tokens', extra = {}) => ({
  taskId,
  agentId: 'agent-a',
  sessionId: 'session-a',
  name: 'Backend agent',
  teamId: 'backend',
  scopes: ['src/api'],
  ...extra,
});
