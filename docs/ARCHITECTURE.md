# Architecture and operation

## Data ownership

A project is the nearest directory containing `.nexo/project.json`. Explicit initialization uses the current Git root, or the current directory outside Git. Discovery selects the closest manifest, allowing existing nested projects. To create an independent board inside a monorepo, use MCP init with `directoryMode=directory` or CLI `init --here` in the desired package.

The installed plugin contains no project data. Its bundled runtime can be updated without moving the database. `.nexo/local/` belongs to the machine and must never enter Git. Clones and worktrees do not inherit active agents. `project.json` has a versioned schema and project capacity settings; configuration is reviewed in Git and the running service reconciles changes.

## Path of a change

1. MCP forwards a command to the single service for the directory using a local bearer token.
2. The service validates the schema, expected version, conflict-free history, hierarchy, dependencies, completion, evidence and lease.
3. A SQLite transaction records the new state and an outbox event. Constraints and `BEGIN IMMEDIATE` serialize claims.
4. The event is exported to a new file through temporary writing, fsync and rename. The command returns only after export. A crash before export is recovered from the committed outbox on restart.
5. SSE notifies browser clients. The browser fetches complete current state, including on reconnection after an instance restart.
6. A queue rebuilds the distributable SQLite in a separate file, closes and validates it, then renames it over `project.sqlite`. Durable changes debounce for 500 ms with a 5-second maximum initial wait. Heartbeats and releases do not create snapshots. Explicit `snapshot` waits through the generation visible at invocation. File replacement failures have bounded asynchronous retries and automatic recovery; they do not make the live database unhealthy. See [concurrency details](CONCURRENCY.md).

Runtime rows are not copied. The snapshot has empty agent tables for consistent inspection, but no leases, tokens or PIDs. Live SQLite in `local/` uses WAL and `synchronous=FULL`. WAL files are never committed.

## Git, causality and recovery

Every event has a UUID, project ID, schema, idempotent command, causal parents and SHA-256 envelope hash. The hash detects accidental changes; it is not a cryptographic author signature. Parents form a DAG. Topological replay with UUID tie-breaking is deterministic. Concurrent updates to the same version produce an explicit conflict; the losing change is not silently applied.

After a merge, retain the union of events from both branches. Missing parents block import. Never remove one event while retaining its descendants. A checkout of an earlier branch must remove the complete causal tail absent from that branch. The service rebuilds the projection from present files and invalidates leases because their work basis may have changed.

Recovery procedure:

1. Preserve a copy of `.nexo/`; resolve conflicting or missing JSON files in Git.
2. Run `/nexo:doctor` or `<plugin>/bootstrap/nexo doctor --project <root>` (`nexo.exe` on Windows). The launcher manages Node; see [runtime setup](RUNTIME.md) for cache selection outside Claude.
3. Review version conflicts and resulting state. `resolve <event-id>` explicitly acknowledges a losing event in `resolutions.json`.
4. Reapply the desired intent as a new command using the current version. Acknowledging a loser does not apply its content.
5. Run `snapshot`; commit the events, resolutions and reconstructed SQLite together.

If only the binary snapshot conflicts, replace it with the reconstructed snapshot. Do not delete `events/` or `.nexo/local/` during an active session. Without the local outbox, unacknowledged work may not have been exported.

## Service and worktrees

The service binds to `127.0.0.1` on an available port. The registry records its PID, random instance ID, directory and token. Clients check identity through health requests. Startup uses a mutex and a detached process with a hidden window on Windows. Each Store holds a separate lifetime writer mutex, including when `serve` is started directly. Mutexes use SQLite locks in persistent, Git-ignored files. Process death releases ownership; no timeout supersedes a live owner. Never remove these files. Upgrades use authenticated graceful shutdown for that directory, without downgrades or PID-based termination. The service stays available after a Claude session to keep the board open.

By default each checkout has its own service and branch view, keeping plans from different branches separate. For teams working in other worktrees on the same delivery through **one coordinator board**, set `NEXO_PROJECT_ROOT=<coordinator-checkout>` and `NEXO_WORKSPACE=<team-worktree>` in the Claude process. The `run` helper does this. The coordinator receives events; the team writes in its worktree. Commit integration remains explicit.

Never use Claude's internal `~/.claude/teams` directory as Nexo storage. Claude sessions and agents supply identities/context; MCP and leases provide board coordination state. Stopping an agent ends its association but does not establish successful implementation.

## Release limits

SQLite has one writer and local queries with FTS5 search. JSON history and complete replay favor auditability and recovery. The board fetches complete state and paginates list rendering; it has no complete virtualization or distributed service. Measure replay latency and snapshot size before adopting tens of thousands of events. No large-project SLO has been validated.

There is no network replication, team authentication, vector search, remote synchronization, major-schema migration engine, account-wide Anthropic budget control or filesystem sandbox. Unknown schema versions are rejected instead of destructively migrated. These capabilities need separate implementation and validation for concrete requirements.
