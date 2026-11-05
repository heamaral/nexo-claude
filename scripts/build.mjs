import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'),
  out = path.join(root, 'plugins/nexo/runtime');
fs.mkdirSync(out, { recursive: true });
const backend = await build({
  absWorkingDir: root,
  entryPoints: [
    './src/cli.ts',
    './src/mcp.ts',
    './src/store.ts',
    './src/server.ts',
    './src/project.ts',
  ],
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
});
const frontend = await build({
  absWorkingDir: root,
  entryPoints: ['./src/web/app.tsx'],
  outdir: path.join(out, 'web'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['chrome120', 'firefox120', 'safari17'],
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
});
fs.writeFileSync(
  path.join(out, 'web/index.html'),
  '<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="description" content="Nexo — your project deliveries, cards and agents, live."><title>Nexo · Project board</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div></body></html>\n',
);
const packages = new Map();
for (const input of [
  ...Object.keys(backend.metafile.inputs),
  ...Object.keys(frontend.metafile.inputs),
]) {
  if (!input.includes('node_modules')) continue;
  let dir = path.dirname(fs.realpathSync(path.resolve(root, input)));
  while (dir !== path.dirname(dir)) {
    const json = path.join(dir, 'package.json');
    if (fs.existsSync(json)) {
      const pkg = JSON.parse(fs.readFileSync(json, 'utf8'));
      if (pkg.name && pkg.version) {
        packages.set(pkg.name + '@' + pkg.version, { dir, pkg });
        break;
      }
    }
    dir = path.dirname(dir);
  }
}
let notices =
  '# Third-party notices\n\nThis file is generated from the packages included in the bundled JavaScript runtime. Their original licenses apply independently of the MIT-licensed Nexo source. Native launcher notices are in plugins/nexo/bootstrap/THIRD_PARTY_NOTICES.md (bootstrap/THIRD_PARTY_NOTICES.md inside the plugin). The privately downloaded Node runtime includes its own LICENSE.\n';
for (const [name, { dir, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices += '\n## ' + name + '\n\nLicense: ' + String(pkg.license ?? 'See package notices') + '\n';
  for (const file of fs
    .readdirSync(dir)
    .filter(
      (f) =>
        /^(licen[cs]e|copying|notice)(\.|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile(),
    )
    .sort())
    notices +=
      '\n' +
      file +
      '\n\n```text\n' +
      fs.readFileSync(path.join(dir, file), 'utf8').trim() +
      '\n```\n';
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
fs.writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), notices);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, '../LICENSE'));
console.log('Built self-contained Claude plugin runtime and local board.');
