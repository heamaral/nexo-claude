import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findProject, initialize } from '../plugins/nexo/runtime/project.mjs';
import { fixture } from './helpers.mjs';
test('nearest nested board wins, init is idempotent and existing project commands are preserved', () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q', f.root]);
    const nested = path.join(f.root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findProject(nested), f.root);
    assert.equal(initialize(nested).root, f.root);
    const created = initialize(nested, 'Nested board', { exact: true });
    assert.equal(findProject(nested), nested);
    assert.notEqual(created.config.id, f.store.config.id);
    const alias = path.join(nested, '.claude/commands/board.md');
    fs.writeFileSync(alias, 'Existing user command');
    const again = initialize(nested, undefined, { exact: true });
    assert.equal(again.created, false);
    assert.equal(fs.readFileSync(alias, 'utf8'), 'Existing user command');
  } finally {
    f.close();
  }
});
