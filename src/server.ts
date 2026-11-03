import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { VERSION } from './version.js';
import { NexoError, assert } from './model.js';
import { atomicWrite, localDir, loadConfig } from './project.js';

export async function startServer(
  root: string,
  options: { token?: string; port?: number; assets?: string; registry?: boolean } = {},
) {
  const store = new Store(root),
    token = options.token ?? crypto.randomBytes(32).toString('base64url'),
    instance = crypto.randomUUID();
  const assets = options.assets ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  const clients = new Set<http.ServerResponse>(),
    tickets = new Map<string, number>(),
    sessions = new Map<string, number>();
  // Cookies are not isolated by TCP port. Give each project/check-out its own name.
  const cookieName =
    'nexo_' +
    crypto
      .createHash('sha256')
      .update(root + '\0' + store.config.id)
      .digest('hex')
      .slice(0, 16);
  let origin = '',
    error: string | undefined,
    flush: NodeJS.Timeout | undefined,
    shuttingDown = false;
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const broadcast = () => {
    for (const res of clients) {
      if (res.writableLength > 65536) {
        res.destroy();
        clients.delete(res);
      } else
        res.write(
          `id: ${instance}:${store.revision}\nevent: change\ndata: ${JSON.stringify({ revision: store.revision, error })}\n\n`,
        );
    }
  };
  store.onChange = () => {
    broadcast();
    clearTimeout(flush);
    flush = setTimeout(() => {
      try {
        store.snapshot();
      } catch (e) {
        error = 'Snapshot: ' + String(e);
        broadcast();
      }
    }, 500);
  };
  async function readBody(req: http.IncomingMessage) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= 262144, 'BODY_LIMIT', 'Corpo excede 256 KiB', 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new NexoError('INVALID_JSON', 'JSON inválido', 400);
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const url = new URL(req.url ?? '/', origin);
      assert(req.headers.host === new URL(origin).host, 'HOST_DENIED', 'Host inválido', 403);
      assert(
        !req.headers.origin || req.headers.origin === origin,
        'ORIGIN_DENIED',
        'Origem inválida',
        403,
      );
      assert(
        !req.headers['sec-fetch-site'] ||
          ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])),
        'CROSS_SITE',
        'Requisição de outro site bloqueada',
        403,
      );
      if (url.pathname === '/api/health' && req.method === 'GET')
        return send(res, 200, { instance, version: VERSION });
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      const candidate = Buffer.from(bearer),
        secret = Buffer.from(token);
      const privileged =
        candidate.length === secret.length && crypto.timingSafeEqual(candidate, secret);
      const cookie = String(req.headers.cookie ?? '').match(
        new RegExp('(?:^|;\\s*)' + cookieName + '=([a-zA-Z0-9_-]+)'),
      )?.[1];
      const loggedIn = !!cookie && (sessions.get(cookie) ?? 0) > Date.now();
      if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
        const body = await readBody(req);
        assert(
          typeof body.ticket === 'string' && (tickets.get(body.ticket) ?? 0) > Date.now(),
          'AUTH_REQUIRED',
          'Link expirado. Abra /board novamente.',
          401,
        );
        tickets.delete(body.ticket);
        const session = crypto.randomBytes(32).toString('base64url');
        sessions.set(session, Date.now() + 8 * 3600_000);
        res.setHeader(
          'Set-Cookie',
          `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return send(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        assert(privileged || loggedIn, 'AUTH_REQUIRED', 'Autenticação local necessária', 401);
        if (req.method === 'GET' && url.pathname === '/api/state')
          return send(res, 200, { ...store.state(), instance, healthError: error ?? null });
        if (req.method === 'GET' && url.pathname === '/api/search')
          return send(res, 200, store.search(url.searchParams.get('q') ?? ''));
        if (req.method === 'GET' && url.pathname === '/api/events') {
          assert(clients.size < 64, 'CAPACITY', 'Muitas conexões de board', 429);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write('retry: 1500\n\n');
          clients.add(res);
          res.write(`id: ${instance}:${store.revision}\nevent: change\ndata: {}\n\n`);
          req.on('close', () => clients.delete(res));
          return;
        }
        assert(
          req.method === 'POST' && privileged,
          'READ_ONLY',
          'Board é de acompanhamento. Alterações são feitas pelo Claude.',
          403,
        );
        if (url.pathname === '/api/shutdown') {
          send(res, 200, { ok: true });
          setImmediate(() => void close());
          return;
        }
        assert(!error, 'PROJECT_UNHEALTHY', error ?? 'Erro de sincronização');
        const body = await readBody(req);
        if (url.pathname === '/api/ticket') {
          const ticket = crypto.randomBytes(32).toString('base64url');
          tickets.set(ticket, Date.now() + 60_000);
          return send(res, 200, { url: origin + '/#ticket=' + ticket });
        }
        if (url.pathname === '/api/command') return send(res, 200, store.execute(body));
        if (url.pathname === '/api/claim') return send(res, 200, store.claim(body));
        if (url.pathname === '/api/heartbeat') {
          assert(typeof body.token === 'string', 'INVALID_TOKEN', 'Token necessário', 400);
          return send(res, 200, store.heartbeat(body.token, body.activity));
        }
        if (url.pathname === '/api/release') {
          assert(typeof body.token === 'string', 'INVALID_TOKEN', 'Token necessário', 400);
          return send(res, 200, store.release(body.token));
        }
        if (url.pathname === '/api/session-end') {
          assert(typeof body.sessionId === 'string', 'INVALID_SESSION', 'Sessão necessária', 400);
          store.releaseSession(body.sessionId);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/hook') {
          assert(
            typeof body.sessionId === 'string' && typeof body.agentId === 'string',
            'INVALID_ACTOR',
            'Identidade necessária',
            400,
          );
          const actors = store
            .agents()
            .filter((a) => a.agentId === body.agentId && a.sessionId === body.sessionId);
          if (['SubagentStop', 'Stop', 'StopFailure'].includes(body.event)) {
            for (const a of actors) store.release(a.token);
            return send(res, 200, { ok: true });
          }
          if (body.event === 'SessionEnd') {
            store.releaseSession(body.sessionId);
            return send(res, 200, { ok: true });
          }
          if (['PreToolUse', 'PostToolUse'].includes(body.event)) {
            const a = actors.find((a) => a.state === 'working');
            if (['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell'].includes(body.toolName))
              assert(
                a,
                'CLAIM_REQUIRED',
                'Antes de usar ferramentas de escrita ou shell, registre este agente em um card com claim. agentId=' +
                  body.agentId,
              );
            if (a && ['Write', 'Edit', 'MultiEdit'].includes(body.toolName)) {
              assert(
                a.role !== 'reviewer',
                'READ_ONLY_CLAIM',
                'Revisor não possui escopo de escrita',
              );
              assert(
                typeof body.filePath === 'string',
                'PATH_REQUIRED',
                'Caminho de arquivo necessário',
                400,
              );
              const workspace =
                typeof body.workspace === 'string' ? fs.realpathSync.native(body.workspace) : root;
              const absolute = path.resolve(workspace, body.filePath),
                relative = path.relative(workspace, absolute).replaceAll('\\', '/');
              assert(
                relative && !relative.startsWith('../') && !path.isAbsolute(relative),
                'SCOPE_DENIED',
                'Arquivo fora do workspace',
              );
              assert(
                a.scopes.some(
                  (scope) =>
                    scope === '.' || relative === scope || relative.startsWith(scope + '/'),
                ),
                'SCOPE_DENIED',
                'Arquivo fora do escopo registrado',
              );
              let parent = path.dirname(absolute);
              while (parent !== workspace) {
                if (fs.existsSync(parent))
                  assert(
                    !fs.lstatSync(parent).isSymbolicLink(),
                    'SYMLINK_DENIED',
                    'Não escreva através de symlink',
                  );
                const up = path.dirname(parent);
                if (up === parent) break;
                parent = up;
              }
              if (fs.existsSync(absolute))
                assert(
                  !fs.lstatSync(absolute).isSymbolicLink(),
                  'SYMLINK_DENIED',
                  'Não escreva através de symlink',
                );
            }
            if (a)
              store.heartbeat(
                a.token,
                body.toolName ? `Usando ${String(body.toolName).slice(0, 80)}` : undefined,
              );
          }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/snapshot') {
          store.snapshot();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/resolve') {
          assert(
            Array.isArray(body.eventIds) &&
              body.eventIds.every((v: unknown) => typeof v === 'string'),
            'INVALID_RESOLUTION',
            'eventIds necessários',
            400,
          );
          store.resolve(body.eventIds);
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'NOT_FOUND' });
      }
      assert(req.method === 'GET' || req.method === 'HEAD', 'METHOD', 'Método inválido', 405);
      const files: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'application/javascript'],
        '/app.css': ['app.css', 'text/css; charset=utf-8'],
      };
      const entry = files[url.pathname];
      assert(entry, 'NOT_FOUND', 'Arquivo não encontrado', 404);
      const content = fs.readFileSync(path.join(assets, entry[0]));
      res.writeHead(200, { 'Content-Type': entry[1] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      const err = e as any;
      send(res, err.status ?? (err.name === 'ZodError' ? 400 : 500), {
        error: err.code ?? 'INVALID_REQUEST',
        message: err instanceof Error ? err.message : 'Erro interno',
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as any).port;
  origin = `http://127.0.0.1:${port}`;
  const registry = { version: 1, pid: process.pid, instance, port, token, root };
  if (options.registry !== false)
    atomicWrite(path.join(localDir(root), 'server.json'), JSON.stringify(registry));
  store.snapshot();
  const synchronize = () => {
    try {
      const config = loadConfig(root);
      assert(
        config.id === store.config.id,
        'PROJECT_CHANGED',
        'A identidade do projeto mudou. Reinicie o serviço no diretório correto.',
      );
      if (JSON.stringify(config) !== JSON.stringify(store.config)) {
        store.config = config;
        store.changed();
      }
      store.sync();
      store.readResolutions();
      if (error) {
        error = undefined;
        broadcast();
      }
    } catch (e) {
      const next = String(e);
      if (error !== next) {
        error = next;
        broadcast();
      }
    }
  };
  let reconcile: NodeJS.Timeout | undefined;
  const watcher = fs.watch(store.eventsDir, () => {
    clearTimeout(reconcile);
    reconcile = setTimeout(synchronize, 150);
  });
  const periodic = setInterval(() => {
    synchronize();
    broadcast();
    for (const [k, expiry] of tickets) if (expiry < Date.now()) tickets.delete(k);
    for (const [k, expiry] of sessions) if (expiry < Date.now()) sessions.delete(k);
  }, 3000);
  periodic.unref();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(flush);
    clearTimeout(reconcile);
    clearInterval(periodic);
    clearInterval(heartbeat);
    watcher.close();
    for (const client of clients) client.end();
    store.snapshot();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    const file = path.join(localDir(root), 'server.json');
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).instance === instance) fs.rmSync(file);
    } catch {}
  }
  return { server, store, registry, origin, close };
}
