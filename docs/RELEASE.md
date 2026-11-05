# Release criteria

## 1.0.0-rc.6 — managed private runtime

Native launchers remove the Node installation and node_path onboarding requirement. First use downloads the release-pinned Node 24.22.2 for the native platform, verifies archive and executable digests, probes SQLite and activates an immutable cache generation. Process-safe installation locks, bounded retries, shared failure cooldown and retained versions support simultaneous clients and recovery. MCP initializes while setup runs and exposes runtime_status; no global Node, PATH or project dependency changes are made. Cached starts work offline. Windows/macOS/glibc Linux x64 and ARM64 artifacts are included; CI exercises the available host architectures. See [operation and trust boundaries](RUNTIME.md). This remains a release candidate.

## 1.0.0-rc.5 — English interface and documentation

The browser interface, default labels, accessibility text, runtime messages, plugin metadata and examples use English. Documentation is translated and screenshots are regenerated from the English UI with English fixture data. Existing project content retains its original language. No schema keys, IDs or workflow phase values are renamed. This release does not introduce a managed Node runtime or promote the project to stable.

## 1.0.0-rc.4 — public launch preparation

Nexo adopted MIT, including the bundled plugin license. The main and plugin READMEs introduced installation, hierarchy versus dependencies, agent ownership, local data, evidence and limitations in English. Third-party notices were preserved. The browser interface was still Portuguese in this release. Coordination behavior was unchanged; no speedup or token-saving benchmark was claimed.

## 1.0.0-rc.3

Snapshot publication was hardened for concurrency: one directory writer with an OS-managed SQLite mutex; startup without stealing live locks by age; a queue coalescing callers by durable generation; heartbeats/releases without snapshot reconstruction; bounded asynchronous EPERM/EACCES/EBUSY retries and automatic backoff recovery. Export failures preserve the last complete snapshot and do not block agents. Shutdown drains HTTP and preserves live SQLite/outbox even when publication fails. Pending events are exported before Git reconciliation. See [concurrency and operation](CONCURRENCY.md).

Tests added real concurrent processes, forced crashes, unexported outbox recovery, coalescing, newer generations, retry deadlines, automatic recovery, failed shutdown publication and a Windows handle without delete sharing. These checks do not replace the pilot, recovery and scale criteria below.

## 1.0.0-rc.2

The delivery path became an interactive graph with branches, joins, dependency/hierarchy modes, external context, zoom/pan and fullscreen. Graceful upgrades preserve cards and leases when replacing an older service. See [the graph guide](GRAPH.md). No database migration was needed.

## 1.0.0-rc.1

Implemented the Claude Code plugin with a private marketplace, bundled MCP stdio, planner/worker/reviewer, skills, hooks, per-directory state, SQLite/event history, fenced leases, delivery workflows, evidence, cycle prevention, immutable accepted history, FTS5, authenticated loopback HTTP, SSE, themes and modals.

Tests cover eight simultaneous claims, lease loss, scope contention, versions/idempotency, combined cycles, evidence, history, replay after checkout, branch conflicts, runtime-free snapshots, HTTP host/origin/auth/body checks, SSE, official MCP protocol, browser sizes and reduced motion. Consult CI for the exact tested revision.

## Before stable 1.0.0

- [x] Windows/Linux/macOS and Chromium Linux CI at commit 0346bd4, with path/layout fixes confirmed.
- [x] Private marketplace and per-project installation in an isolated Claude profile, including configured node_path.
- [ ] Interactive `/board` pilot in the primary user installation.
- [x] Native planner/worker created and completed a fixture delivery, with observed agent entry/exit.
- [ ] Real feature pilot with edits, integration and review on the same commit.
- [x] Two simultaneous sessions in separate worktrees using one coordinator.
- [x] `run` helper validated with existing authentication, normal permissions and explicit budget.
- [ ] Force-stop a Claude session, resume and verify recovery without duplicate completion.
- [ ] Perform a real concurrent-change merge and review resolution.
- [ ] Define and measure scale/SLO for the largest intended projects.
- [ ] Security review and recovery on a clean machine.

These are release quality criteria, not approval requirements for reversible work. Do not describe production readiness as validated while they remain open.
