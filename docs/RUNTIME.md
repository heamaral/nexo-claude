# Managed runtime proposal

Status: proposed, not implemented in rc.5. The current plugin still requires Node.js 24.22.x and a configured `node_path` where Node 24 is not on PATH.

## Recommendation for Nexo

Make the runtime a Nexo-managed dependency. A deterministic, platform-specific launcher should work before Node is available, obtain an exact tested runtime pack when necessary, and launch the bundled MCP/CLI with that private executable. The AI may explain diagnostics, but should not install or change global Node versions during ordinary sessions.

For the current implementation, a private Node runtime plus the existing bundled JavaScript is a lower-risk first step than changing SQLite libraries or migrating to another JavaScript engine. Node single-executable applications are another packaging option, but need a separate compatibility prototype for ESM entry points, embedded web assets and daemon spawning; the existing code cannot simply be renamed to an executable.

## Desired user experience

1. Install the Nexo plugin.
2. The launcher selects the OS and architecture and checks a versioned cache.
3. On first use, install a verified runtime pack if it is absent. Subsequent starts work offline.
4. Launch MCP, hooks and the daemon using the same pinned runtime.
5. `/nexo:init` and `/board` work without a Node-path prompt or PATH changes.

Use Claude's persistent `${CLAUDE_PLUGIN_DATA}` for managed dependencies. Keep per-project records in `.nexo/`; do not commit executable runtimes with each project or write caches into `${CLAUDE_PLUGIN_ROOT}`, which changes between plugin versions. Keep `node_path` as an optional expert override rather than required onboarding.

## Distribution and recovery

- Publish tested runtime packs per supported OS/architecture, with embedded license notices. Version and digest information must come from a trusted, authenticated release manifest, not an unverified checksum beside an arbitrary download.
- Use a process-safe installation lock so simultaneous MCP/hook starts share one download and installation.
- Download to staging, validate the archive, prevent path traversal, verify the digest, run a capability probe including SQLite, then activate atomically.
- Pin a runtime pack per Nexo release. Updates select a new version rather than overwriting an executable used by a running daemon. Retain a known-good version until handoff is complete.
- Keep bootstrap logs off MCP stdout. Provide actionable offline/proxy/download errors and an offline preseed option.
- Do not silently alter global Node, PATH or project package dependencies. Do not require Docker to open a local board.
- Define supported Windows/macOS/Linux targets explicitly; test permissions, antivirus/file-sharing behavior, executable permissions and platform signing requirements.

Before shipping, prototype launcher routing with Claude's actual MCP and hook schemas on each platform. A single cross-platform manifest must not assume the same shell or executable suffix everywhere. Test on clean machines with no Node installed, offline cache reuse, simultaneous starts, interrupted downloads, tampered artifacts, paths containing spaces and runtime upgrade with active leases. First-run setup must also fit the hook timeout behavior or happen through a dedicated setup entry point before normal hooks are enabled.

References: [Claude plugin data and environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables), [Node 24 single-executable applications](https://nodejs.org/download/release/v24.22.1/docs/api/single-executable-applications.html).
