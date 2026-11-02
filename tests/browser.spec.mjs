import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
import { fixture, seed, claim, command } from './helpers.mjs';
test('real board: live agents, themes, modals, flow, mobile and reduced motion', async () => {
  fs.mkdirSync('test-results', { recursive: true });
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'msedge' }),
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'dark',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const headers = {
      Authorization: 'Bearer ' + s.registry.token,
      'Content-Type': 'application/json',
    };
    const ticket = await (
      await fetch(s.origin + '/api/ticket', { method: 'POST', headers, body: '{}' })
    ).json();
    await page.goto(ticket.url);
    await page.getByText('O próximo passo começa aqui.').waitFor();
    seed(s.store);
    s.store.claim(claim());
    s.store.claim(
      claim('form', {
        agentId: 'agent-ui',
        teamId: 'frontend',
        name: 'Frontend agent',
        scopes: ['src/ui'],
      }),
    );
    await page.getByRole('button', { name: /Abrir entrega/ }).click();
    await page.getByRole('heading', { name: 'Recuperação de senha', exact: true }).waitFor();
    await page
      .getByRole('button', { name: /Tokens de uso único/ })
      .first()
      .click();
    await page.locator('dialog[open]').waitFor();
    assert.ok(await page.getByText('Token expira e não pode ser reutilizado').isVisible());
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ver fluxo', exact: true }).click();
    await page.getByText('Um fluxo que acompanha o projeto').waitFor();
    await page.getByText('Critérios de aceitação e testes aprovados na versão integrada').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Times', exact: true }).click();
    await page.getByText('Backend agent', { exact: true }).waitFor();
    assert.equal(await page.locator('.team-card .orbit').count(), 2);
    await page.screenshot({ path: 'test-results/board-dark.png', fullPage: true });
    await page.getByRole('button', { name: 'Ativar tema claro' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.screenshot({ path: 'test-results/board-light.png', fullPage: true });
    await page.getByRole('tab', { name: 'Board', exact: true }).click();
    const before = await page
      .locator('.task-card .orbit rect')
      .first()
      .evaluate((e) => getComputedStyle(e).strokeDashoffset);
    await page.waitForTimeout(150);
    const after = await page
      .locator('.task-card .orbit rect')
      .first()
      .evaluate((e) => getComputedStyle(e).strokeDashoffset);
    assert.notEqual(before, after);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await page
        .locator('.task-card .orbit rect')
        .first()
        .evaluate((e) => getComputedStyle(e).animationName),
      'none',
    );
    const task = s.store.get('form');
    command(
      s.store,
      'task',
      'form',
      { description: 'Atualização real recebida pelo board' },
      'update',
      { leaseToken: s.store.agents().find((a) => a.taskId === 'form').token },
    );
    await page.getByText('Atualização real recebida pelo board', { exact: true }).waitFor();
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        JSON.stringify(
          await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            items: [...document.querySelectorAll('body *')]
              .map((e) => ({
                tag: e.tagName,
                cls: typeof e.className === 'string' ? e.className : 'svg',
                right: e.getBoundingClientRect().right,
                width: e.getBoundingClientRect().width,
              }))
              .filter((e) => e.right > innerWidth + 1)
              .slice(0, 18),
          })),
        ),
      );
      await page
        .getByRole('button', { name: /Tokens de uso único/ })
        .first()
        .click();
      assert.ok(
        await page.locator('dialog').evaluate((e) => e.getBoundingClientRect().width <= innerWidth),
      );
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: 'test-results/board-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await s.close();
    f.close();
  }
});
