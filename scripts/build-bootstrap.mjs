import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'plugins/nexo/bootstrap');
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'runtime-manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildDir = path.join(root, '.bootstrap-build');
fs.mkdirSync(buildDir, { recursive: true });
const helpers = { applicationVersion: pkg.version, artifacts: {} };
if (manifest.applicationVersion !== pkg.version)
  throw new Error('Native runtime manifest version differs from package.json');
if (JSON.stringify(manifest.protocols) !== JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS))
  throw new Error('Native MCP protocol negotiation differs from the bundled SDK');
const go = process.env.NEXO_GO ?? 'go';
function execute(args, env = {}) {
  const result = spawnSync(go, args, {
    cwd: path.join(root, 'bootstrap'),
    env: {
      ...process.env,
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
      GOFLAGS: '',
      GOENV: 'off',
      GOWORK: 'off',
      GOEXPERIMENT: '',
      GOAMD64: 'v1',
      GOARM64: 'v8.0',
      GO386: 'sse2',
      ...env,
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const version = execute(['version']);
if (!version.includes('go1.27.3 '))
  throw new Error('Reproducible bootstrap builds require Go 1.27.3');
for (const [os, arch, name, source] of [
  ['windows', '386', 'nexo.exe', './dispatch'],
  ['windows', 'amd64', 'nexo-windows-amd64.exe', '.'],
  ['windows', 'arm64', 'nexo-windows-arm64.exe', '.'],
  ['linux', 'amd64', 'nexo-linux-amd64', '.'],
  ['linux', 'arm64', 'nexo-linux-arm64', '.'],
  ['darwin', 'amd64', 'nexo-darwin-amd64', '.'],
  ['darwin', 'arm64', 'nexo-darwin-arm64', '.'],
]) {
  const helper = name !== 'nexo.exe';
  const target = path.join(helper ? buildDir : out, name);
  execute(
    ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', target, source],
    { GOOS: os, GOARCH: arch },
  );
  if (helper) {
    const payload = name + '.gz';
    execute(['run', './pack', target, path.join(out, payload)]);
    const raw = fs.readFileSync(target);
    const packed = fs.readFileSync(path.join(out, payload));
    if (packed.length > 5 * 1024 * 1024)
      throw new Error('Helper payload exceeds directory file limit');
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const fields = {
      payloadName: payload,
      payloadDigest: digest(packed),
      helperDigest: digest(raw),
      helperSize: String(raw.length),
      applicationVersion: pkg.version,
    };
    helpers.artifacts[os + '-' + arch] = fields;
    const flags =
      '-s -w -buildid= ' +
      Object.entries(fields)
        .map(([key, value]) => '-X main.' + key + '=' + value)
        .join(' ');
    execute(
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=' + flags,
        '-o',
        path.join(out, name),
        './loader',
      ],
      { GOOS: os, GOARCH: arch },
    );
  }
  if (fs.statSync(path.join(out, name)).size > 5 * 1024 * 1024)
    throw new Error('Native entry point exceeds directory file limit');
  fs.chmodSync(path.join(out, name), 0o755);
  console.log(`Built ${name}`);
}
fs.writeFileSync(path.join(out, 'helper-manifest.json'), JSON.stringify(helpers, null, 2) + '\n');
fs.chmodSync(path.join(out, 'nexo'), 0o755);
const goroot = execute(['env', 'GOROOT']);
let licenses =
  '# Native bootstrap third-party notices\n\nThe Nexo launcher source is MIT-licensed. Its Go runtime and standard library retain their original licenses.\n';
const found = new Set();
function include(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (found.has(text)) return;
  found.add(text);
  licenses += `\n## ${path.relative(goroot, file).replaceAll('\\', '/')}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
}
include(path.join(goroot, 'LICENSE'));
include(path.join(goroot, 'PATENTS'));
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else if (/^(LICENSE|PATENTS)(\.|$)/.test(e.name)) include(file);
  }
}
walk(path.join(goroot, 'src/vendor'));
fs.writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), licenses);
