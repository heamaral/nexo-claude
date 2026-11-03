import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
import { fixture, command } from './helpers.mjs';

test('graph renders branches, hierarchy, external dependencies and live activity; supports modal, search, pan, zoom and mobile', async () => {
  fs.mkdirSync('test-results', { recursive: true });
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  let browser;
  try {
    command(s.store, 'delivery', 'recovery', {
      title: 'Recuperação de senha',
      description: 'Uma entrega, vários caminhos em paralelo.',
    });
    command(s.store, 'team', 'implementation', { deliveryId: 'recovery', title: 'Implementação' });
    command(s.store, 'team', 'security', { deliveryId: 'recovery', title: 'Revisão de segurança' });
    const task = (id, title, deps = [], extra = {}) =>
      command(s.store, 'task', id, { deliveryId: 'recovery', title, dependencies: deps, ...extra });
    const complete = {
      stageId: 'done',
      result: 'Fixture validated',
      evidence: [{ label: 'Fixture tests', commit: 'abc1234' }],
    };
    task('contract', 'Contrato de recuperação', [], complete);
    task('tokens', 'Tokens de uso único', ['contract'], complete);
    task('email', 'Envio do e-mail', ['contract'], {
      blocker: 'Credencial de e-mail pendente',
      teamId: 'implementation',
    });
    task('reset', 'Redefinição de senha', ['tokens'], { teamId: 'implementation' });
    task('audit', 'Revisar segurança dos tokens', ['tokens'], { teamId: 'security' });
    task('integrate', 'Integrar e validar recuperação', ['reset', 'email', 'audit']);
    s.store.claim({
      taskId: 'reset',
      agentId: 'backend-agent',
      sessionId: 'test',
      name: 'Backend',
      teamId: 'implementation',
      scopes: ['src/backend'],
    });
    const reviewer = s.store.claim({
      taskId: 'audit',
      agentId: 'security-agent',
      sessionId: 'test',
      name: 'Auditor',
      teamId: 'security',
      scopes: ['.'],
      role: 'reviewer',
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'msedge' }),
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
      colorScheme: 'dark',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const ticket = await (
      await fetch(s.origin + '/api/ticket', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.registry.token },
        body: '{}',
      })
    ).json();
    await page.goto(ticket.url);
    await page.getByRole('button', { name: 'Abrir entrega' }).click();
    await page.getByRole('tab', { name: 'Caminho', exact: true }).click();
    await page.locator('.graph-node').first().waitFor();
    assert.equal(await page.locator('.graph-node').count(), 6);
    assert.equal(await page.locator('.graph-edge.dependency').count(), 7);
    assert.equal(await page.locator('.graph-node .orbit').count(), 2);
    const position = async (id) =>
      page
        .locator(`[data-node-id="${id}"]`)
        .evaluate((e) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top) }));
    assert.ok((await position('contract')).x < (await position('tokens')).x);
    assert.ok((await position('tokens')).x < (await position('reset')).x);
    assert.ok((await position('reset')).x < (await position('integrate')).x);
    const viewport = page.locator('.graph-viewport');
    await viewport.screenshot({ path: 'test-results/graph-dark.png' });
    await page.locator('[data-node-id="reset"]').click();
    await page.locator('dialog[open]').waitFor();
    await page
      .locator('dialog')
      .getByRole('heading', { name: 'Redefinição de senha', exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Alternar tela cheia do mapa' }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.getByRole('button', { name: 'Ajustar mapa à tela' }).click();
    await page.locator('[data-node-id="contract"]').click();
    await page.locator('dialog[open]').waitFor();
    await page.getByRole('button', { name: 'Fechar detalhe' }).click();
    await page.getByRole('button', { name: 'Alternar tela cheia do mapa' }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.getByRole('button', { name: 'Ajustar mapa à tela' }).click();
    const zoom = await page.locator('.graph-zoom').textContent();
    await page.getByRole('button', { name: 'Aumentar zoom' }).click();
    assert.notEqual(await page.locator('.graph-zoom').textContent(), zoom);
    await page.getByRole('button', { name: 'Ajustar mapa à tela' }).click();
    const world = page.locator('.graph-world'),
      before = await world.getAttribute('style'),
      box = await viewport.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 45, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await world.getAttribute('style'), before);
    const camera = await world.getAttribute('style');
    s.store.heartbeat(reviewer.token, 'Checking live graph updates');
    await page.waitForTimeout(300);
    assert.equal(await world.getAttribute('style'), camera);
    await page.getByRole('button', { name: 'Ajustar mapa à tela' }).click();
    await page.getByRole('textbox', { name: 'Buscar cards' }).fill('Tokens de uso único');
    await page.getByRole('button', { name: '1 encontrados' }).waitFor();
    assert.equal(await page.locator('.graph-node').count(), 6);
    assert.equal(await page.locator('.graph-node.search-match').count(), 1);
    await page.getByRole('button', { name: 'Limpar busca' }).click();
    await page.getByRole('button', { name: 'Ativar tema claro' }).click();
    await viewport.screenshot({ path: 'test-results/graph-light.png' });
    // A topology update adds children to a parent: the graph derives composition without making up dependencies.
    task('parent', 'Sistema de vento');
    task('child-a', 'Contrato do vento', [], { parentId: 'parent' });
    task('child-b', 'Runtime do vento', ['child-a'], { parentId: 'parent' });
    await page.locator('[data-node-id="child-b"]').waitFor();
    await page.getByRole('button', { name: 'Hierarquia', exact: true }).click();
    await page
      .locator('.graph-edge[data-from="parent"][data-to="child-a"]')
      .waitFor({ state: 'attached' });
    assert.ok((await position('parent')).x < (await position('child-a')).x);
    assert.equal(await page.locator('.graph-edge.dependency').count(), 0);
    await page.getByRole('button', { name: 'Dependências', exact: true }).click();
    await page
      .locator('.graph-edge[data-from="child-b"][data-to="parent"]')
      .waitFor({ state: 'attached' });
    command(s.store, 'delivery', 'external', { title: 'Entrega anterior' });
    command(s.store, 'task', 'external-task', {
      deliveryId: 'external',
      title: 'Contrato externo',
      ...complete,
    });
    const latest = s.store.get('child-a');
    command(s.store, 'task', 'child-a', { dependencies: ['external-task'] }, 'update');
    await page.locator('.graph-node.external-node').waitFor();
    assert.equal(await page.locator('.graph-node.external-node').count(), 1);
    const audit = s.store.get('audit');
    command(s.store, 'task', 'audit', complete, 'update', { leaseToken: reviewer.token });
    await page.locator('[data-node-id="audit"].completed').waitFor();
    assert.equal(await page.locator('[data-node-id="audit"] .orbit').count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await page
        .locator('.graph-node .orbit rect')
        .first()
        .evaluate((e) => getComputedStyle(e).animationName),
      'none',
    );
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: 'Ajustar mapa à tela' }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const rect = await viewport.boundingBox();
      assert.ok(rect.width <= width);
    }
    await page.screenshot({ path: 'test-results/graph-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await s.close();
    f.close();
  }
});
