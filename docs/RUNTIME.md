# Managed runtime

Starting in rc.6, Nexo manages its own Node runtime. Install the Claude Code plugin and open your project; no Node installation, node_path configuration, PATH change or project package installation is required. This release pins **Node 24.22.2**. A native launcher prepares that exact version independently of the AI.

## Startup

1. Claude starts a compact native launcher. Windows uses a small dispatcher; macOS/Linux use a POSIX shell selector. Starting in rc.7, the entry point verifies and expands the bundled compressed helper into a private, immutable cache generation. This step is offline and uses digests embedded in the compiled entry point.
2. The launcher checks its private cache against the bundled executable digest. On a cache miss, it takes an OS-managed installation lock and checks again.
3. It downloads the official Node archive over HTTPS, verifies its pinned SHA-256, safely extracts only the executable and license, verifies the executable digest and size, and runs a Node/SQLite capability probe.
4. A fresh immutable directory is activated. MCP, hooks, CLI and the project daemon use the selected executable. Concurrent clients share the installed generation.

MCP initialization responds while preparation continues. The read-only `runtime_status` tool reports progress or an actionable error. When the application is ready, a tools-list notification makes the regular tools discoverable. Application requests during preparation are queued with bounded memory; validation remains in the existing MCP server. Logs use stderr, keeping MCP stdout clean.

An uninitialized project's hooks exit without starting Node or creating a Node cache. The small native helper can be cached first. Helper preparation has a 10-second deadline; Node setup has a 90-second deadline. Initialized-project hooks allow up to 120 seconds. Setup failure does not disable ownership checks.

## Platforms and prerequisites

| System           | Architectures          | Runtime archive      |
| ---------------- | ---------------------- | -------------------- |
| Windows          | x64, ARM64             | Official Node ZIP    |
| macOS            | Intel x64, Apple ARM64 | Official Node tar.gz |
| Linux with glibc | x64, ARM64             | Official Node tar.gz |

The host must meet the pinned official Node release's OS/libc requirements and permit executable files in the cache. Alpine/musl, 32-bit hosts and other architectures are outside the supported set. Ordinary macOS/Linux `/bin/sh`, `uname` and `dirname` select the native launcher. Docker, Go, npm and pnpm are not user dependencies. CI executes all six OS/architecture pairs, including native ARM64 runners; see the validation report for evidence and limits.

## Cache, concurrency and updates

The Node cache is `${CLAUDE_PLUGIN_DATA}/runtimes`; expanded native helpers live in `${CLAUDE_PLUGIN_DATA}/launchers`. Both are separate from the versioned plugin root and each project's `.nexo/`. Hooks and MCP read this path from the environment Claude exports to them, keeping their configured command paths literal. Outside Claude without an explicit data path, the launcher falls back to `${CLAUDE_CONFIG_DIR}/plugins/data/nexo-nexo-marketplace`, or the corresponding `~/.claude` path. Inline plugins can have a different Claude-assigned data directory; pass that directory with `--data` for terminal diagnostics.

Each version/platform/executable digest has a persistent OS lock file. A crash releases ownership; timestamps never justify stealing a live lock. Downloads stage under the cache. Only abandoned staging directories for the locked key are cleaned automatically. Installed generations and lock files are never replaced or removed. Short Windows sharing/access errors during activation receive bounded retries.

Plugin releases select a pinned runtime. A changed pin installs a new generation while old daemons keep their executable. Existing graceful daemon handoff preserves project data and live leases. There is no independent automatic Node upgrade. Old generations remain available; reclaim them manually only after every process using them has stopped.

Transient download errors receive at most three attempts with backoff and jitter inside the deadline. Corrupt digests and HTTP 429 do not trigger immediate retries. Failed attempts create a shared 30-second cooldown so concurrent clients do not hammer the server. Explicit `setup` bypasses the cooldown. Requests use OS certificate trust and HTTP_PROXY/HTTPS_PROXY settings; HTTPS cannot redirect to plaintext. Archive and extraction sizes are bounded.

## Diagnostics and offline use

Use `/nexo:doctor` and the read-only `runtime_status` MCP tool. After fixing a network, certificate, disk or execution-policy problem, reconnect MCP. For explicit terminal recovery:

```sh
<plugin>/bootstrap/nexo --data <persistent-plugin-data> runtime-status
<plugin>/bootstrap/nexo --data <persistent-plugin-data> setup
<plugin>/bootstrap/nexo --data <persistent-plugin-data> doctor --project <project-root>
```

On Windows use `nexo.exe`. `runtime-status` checks the cache without downloading; `setup` prepares it and reports JSON. Cache-miss setup needs internet access. Cached startup requires no network access.

For offline deployment, run `setup` on a connected machine of the **same OS and architecture** using the same Nexo release. Copy the completed `runtimes/node-<version>-<platform>-<digest>-<generation>/` directory, including the executable and LICENSE, into the destination plugin-data `runtimes/` directory. Preserve executable permissions on Unix. The launcher validates the executable digest on reuse. Do not copy project tokens, runtime lock files or incomplete `.stage-*` directories. An unverified archive placed in the cache is not an offline installation.

The optional environment variable `NEXO_NODE_PATH` selects a trusted compatible Node executable (major 24, at least 24.22.0), checked with the SQLite probe. This expert override skips managed download. It is not an installation prompt; old saved `node_path` plugin settings are ignored. Private subprocesses strip NODE_OPTIONS and NODE_PATH to avoid accidental global injection.

## Build and trust

Launcher source lives in `bootstrap/`. `pnpm build:bootstrap` requires Go **1.27.3** and cross-compiles the executables using fixed settings. The pinned Go toolchain creates deterministic gzip payloads, and each small entry point embeds the expected compressed and expanded helper digests and size. Source, payload hashes and the helper manifest remain available for review. This packaging keeps each distributed file below the directory's 5 MiB hard limit; compiled files and large bundles still require Anthropic's human review. CI rebuilds and compares committed artifacts, runs native tests and real runtime acceptance, and tests a non-root Linux container with no Node installed plus offline cache reuse. The container is a validation fixture only.

The bundled manifest supplies trusted archive/executable digests and supported MCP protocols, checked against the bundled SDK during builds. Updating the pin requires authenticating official vendor checksums, verifying all archives, deriving executable digests and running release checks. Runtime licenses accompany the cache; Go and JavaScript notices accompany the plugin.

The plugin source, distribution and manifest must be trusted. Checksums do not protect a replaced plugin distribution. Native artifacts are not separately OS-signed/notarized; enterprise deployment must follow its execution policy. See [security boundaries](../SECURITY.md), [validation evidence](VALIDATION.md) and the remaining [stable-release criteria](RELEASE.md).

References: [Claude plugin data and environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables), [official pinned Node checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt).
