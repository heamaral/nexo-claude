# Validation evidence

These results describe specific tested environments. They are not performance guarantees for every machine or project size.

## rc.6 — managed runtime (2026-11-05)

A real Windows Claude Code 2.1.316 launch used an isolated profile and project with Node removed from PATH. Claude discovered and connected to the plugin's native MCP entry point, expanded the persistent plugin-data path and did not request node_path configuration.

The opt-in `pnpm test:runtime` trial used a fresh private cache and the production manifest. It downloaded and verified Node 24.22.2, created project records and a lease, disconnected MCP, reconnected with deliberately unusable HTTP/HTTPS proxies, and renewed the original lease before releasing it. Cold MCP initialization took 98 ms in the first local trial, while runtime setup continued in the background. This measures connection responsiveness, not download completion or a universal latency guarantee.

Native tests exercise ZIP/tar extraction, archive/executable tampering, capability failures, interrupted downloads, bounded retries, shared failure cooldown, rate limiting, offline reuse, immutable upgrades, four concurrent installer processes, live-lock preservation, crash recovery and MCP discovery/queuing. Two additional application tests launch without Node on PATH, reuse an offline fixture, strip ambient Node options and skip runtime installation for hooks outside Nexo projects. CI covers all six supported OS/architecture pairs with native GitHub-hosted runners: Linux x64/ARM64, Windows x64/ARM64 and macOS Intel/Apple Silicon. Each rebuilds all artifacts and runs native Claude's MCP health check with Node absent from PATH, in addition to fresh runtime installation and offline reuse. A separate non-root Linux container starts with no Node installed, then repeats setup with networking disabled. Consult the published commit's CI for results; these fixtures do not replace field deployments or the broader stable-release gates.

## rc.3 — concurrency and snapshot publication (2026-11-03)

Windows, Node 24.22.1, Claude Code 2.1.316: 29 core tests and two browser scenarios passed. New coverage included interprocess writer ownership, release after a real crash, startup without stealing ownership by age, outbox recovery, 40 snapshot requests across two generations, persistent failure deadlines, recovery of a Git-modified binary, nonfatal warnings and automatic recovery, failed shutdown publication, and rejection of a mutation whose body was still arriving. An actual Windows handle without `FILE_SHARE_DELETE` reproduced replacement failure, allowed heartbeat, and released publication when closed.

An additional local trial used the **installed** rc.2 runtime with three concurrent rc.3 clients in an isolated project. The instance was replaced once; delivery/card data and the original lease token remained valid. An rc.2 client reused the rc.3 daemon. No existing project process was stopped. Types, formatting and official plugin/marketplace validation passed. Multiplatform results are recorded in CI for the published revision.

## Native Claude trials (2026-11-02)

Environment: Windows, Node 24.22.1 and Claude Code 2.1.316. The opt-in `scripts/acceptance.mjs` loaded the plugin with `--plugin-dir` in an authenticated temporary repository:

- A native planner created a delivery, workflow, team, cards and dependency through MCP.
- The planner registered its own claim; a stale update was rejected and recovered through a new state read.
- Native `nexo:worker` received its hook identity, claimed its card and recorded results/evidence.
- Both cards were completed, the delivery was accepted and no active agents remained.
- The subagent shared its parent sessionId and had its own agentId, following the native Claude model.

`scripts/acceptance-parallel.mjs` started two `run` helpers in distinct Git worktrees using one coordinator:

- Two active agents were observed simultaneously in the same project.
- Sessions read both teams, completed their own cards with their pre-acquired leases and released their associations.
- Both processes exited successfully with no remaining active agents.

These are protocol/lifecycle trials in fixtures, without a product feature implementation or automatic shell approval. They do not replace a complete pilot with edits, integration and review in a real project.

## Automated verification

Core tests cover versions, idempotency, hierarchy/cycles, concurrent claims, overlapping scopes, expiration/fencing, evidence, accepted history, snapshots, replay, branch conflicts, project isolation, nested discovery, HTTP and the official MCP protocol. Browser scenarios exercise real data, SSE, themes, modals, workflows, graphs, animations, reduced motion and viewports including 1440/1024/768/390/320.

Official plugin and marketplace validation passed in strict mode, including the directory profile. Production dependency auditing reported no known vulnerabilities in that execution.

## Initial local measurements

Fixture: 1,000 cards in a dependency chain, 1,001 events, one delivery and no executing agents. Durable writes were individual operations on a local SSD.

| Operation                                        | Observed time |
| ------------------------------------------------ | ------------: |
| Create 1,000 cards and events                    |        6.47 s |
| Generate a closed SQLite snapshot                |        112 ms |
| Read complete state                              |       2.59 ms |
| Search with FTS5                                 |       2.16 ms |
| Rebuild after removing only the local projection |        480 ms |
| Resulting snapshot size                          |       1.27 MB |

The event ledger uses metadata caching, a persisted causal frontier and indexed queries to avoid rereading every file for each command. Replay and snapshot construction still traverse complete history. This is not an SLO for tens of thousands of cards or multiple users.

## Distribution

Initial installation used the then-private `heamaral/nexo-claude` repository in an isolated Claude profile and workspace project, with project scope and an explicit node_path. The CLI confirmed enabled rc.1. CI for commit 0346bd4 passed Windows, Linux, macOS and Chromium Linux: [CI run](https://github.com/heamaral/nexo-claude/actions/runs/41541804042).

The repository subsequently became public under MIT in rc.4. The English UI and regenerated example screenshots are introduced in rc.5; consult that revision's CI for current results.
