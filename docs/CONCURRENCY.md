# Concurrency, snapshots and recovery

## Ownership and transactions

All MCP clients, sessions and agents for a directory use one authenticated loopback daemon. An agent lease coordinates task/scopes; it is not a database connection or a snapshot writer. Claims and durable commands use short `BEGIN IMMEDIATE` transactions in `.nexo/local/state.sqlite`, with WAL and `synchronous=FULL`. SQLite remains suitable for a local single-host coordinator. A network service or distributed writers would require a separate architecture, not a shared SQLite file on SMB/NFS.

From rc.3, every Store acquires a lifetime SQLite mutex in `.nexo/local/writer.sqlite` **before opening the live database**. Startup/handoff has a separate mutex in `startup.sqlite`. These connections hold an uncommitted `BEGIN IMMEDIATE` in dedicated files, never in the live data database. The OS releases locks on process exit, including a crash. A slow/suspended process is never superseded because its timestamp expired. Mutex files are persistent: do not unlink, rename or replace them. PID metadata is diagnostic; new-protocol ownership is checked using the actual mutex, avoiding stale PID reuse.

The legacy `startup.lock/` guard is retained for rc.1/rc.2 compatibility. A current client can reclaim an abandoned protocol-2 guard only while it owns the OS startup mutex. An unidentified legacy guard is not deleted by age. Reload legacy clients and investigate such a guard instead of deleting arbitrary state during execution. Binaries before rc.3 cannot honor a mutex they were not written to use: all sessions for a coordinator should be upgraded/reloaded. Registered old daemons are replaced through authenticated graceful shutdown; unrelated directories are not touched. An unregistered legacy writer cannot be fenced by new application code and must be identified before adoption.

## Live state versus a Git snapshot

The live SQLite and committed event outbox are authoritative for work on this machine. JSON events are the tracked merge/rebuild history. `.nexo/project.sqlite` is a derived, closed, portable snapshot; it excludes agent rows, fencing counters and tokens. A reader of this file must not prevent agents from keeping leases alive.

Durable changes mark a generation dirty. Heartbeats and releases notify SSE without changing that generation. Automatic publication debounces for 500 ms, with a 5 s maximum initial wait during continuous changes. Explicit requests join one in-flight publisher and, if needed, publish the next generation. Each caller waits through the generation visible at invocation; later edits can remain pending. Quiet the coordinator before a Git commit that must include the latest generation, run `snapshot`, check `snapshot.dirty === false`, and stage the associated events/resolutions and SQLite together. Git changes can still race if other sessions keep editing.

A publication reads all copied tables inside one SQLite read transaction, builds a separate rollback-journal database, commits, runs `quick_check`, closes it and flushes the file. Only then is it renamed over the destination. Directory metadata is fsynced on POSIX; Windows has no portable directory-fsync API in Node. The live WAL is never copied or renamed. If replacement fails, the previous destination remains complete. No delete-first or in-place-copy fallback is used. Unpublished temporary files are cleaned up where possible; a scanner can also delay cleanup.

`EPERM`, `EACCES` and `EBUSY` are retried asynchronously with exponential delay/jitter for up to 3 seconds per publication attempt. These codes do not prove which process owns a handle; EACCES can also be a persistent ACL problem. Other errors fail promptly. Automatic recovery retries at 1, 2, 4, 8, 16 and then 30-second intervals; new card edits do not defeat that backoff. Explicit snapshot requests may retry immediately. A permanent lock, denied permission or full disk still requires operator action. The application cannot promise a file rename will succeed while the OS denies it.

`state.snapshot` and `doctor` report status, dirty/published generations, attempts, publication count, last success and the last error code/operation/time. This warning is distinct from `healthError`, which represents configuration/history reconciliation problems. Snapshot errors do not deny commands, claims, heartbeats or releases. Board warnings clear only after a successful publication, not merely after a successful history scan. A failed explicit snapshot returns `SNAPSHOT_PENDING`/HTTP 503; do not commit a stale snapshot as though it were current.

## Shutdown, upgrades and ambiguous requests

Shutdown advertises draining, rejects mutations whose bodies have not yet been accepted with `SERVER_DRAINING`, ends SSE, closes idle sockets and drains accepted HTTP work. It then attempts the final snapshot. A publication failure is logged but does not prevent closing SQLite and releasing ownership: the next owner recovers from live state/outbox. Leases and fencing survive a normal handoff. Importing a different Git history intentionally invalidates leases as documented in the architecture guide.

The client retries an explicit `SERVER_DRAINING` rejection once through discovery. It does **not** blindly replay a mutation after a network timeout: the server might have committed it. Retry durable commands with the exact original `commandId` and contents; inspect state before recovering a claim. Committed outbox entries are exported before reconciliation and before an idempotent response, so a failed event export cannot be mistaken for branch deletion.

## Troubleshooting a Windows sharing violation

1. Update the marketplace/plugin in the project, then `/reload-plugins` in its Claude sessions. Reopen `/board`. Only that coordinator's daemon is handed off; services for other project directories are independent.
2. Inspect `doctor` / `state.snapshot`. A healthy live database with a pending snapshot is a recoverable export problem, not evidence of data corruption.
3. Close database viewers or tools reading `.nexo/project.sqlite`, then retry `snapshot`. For repeated failures, use Microsoft Process Explorer **Find Handle or DLL** or Sysinternals Handle against the exact path; a list of Node processes alone does not identify the handle owner. Do not force-close arbitrary handles or disable antivirus as a workaround.
4. Verify directory/file permissions and disk space if the code persists. Never delete `state.sqlite`, its WAL/SHM, events, the old destination or ownership files to get past the error.
5. If a registered legacy daemon cannot complete graceful shutdown, leave it and its data intact, collect its log/version/project path and finish/reload its sessions. The updater fails closed instead of launching a second writer or killing an unrelated PID.

## Validation and limits

Tests exercise concurrent clients and claims, real process crashes, startup ownership, durable outbox recovery, coalesced snapshot requests, newer generations arriving during publication, bounded persistent failures, automatic recovery, draining with a partially streamed request and shutdown after export failure. Windows additionally opens the actual snapshot without `FILE_SHARE_DELETE`, verifies a sharing violation and live heartbeats, releases the handle and verifies publication. Browser tests verify the nonfatal warning and recovery over SSE. CI runs the core suite on Windows, Linux and macOS.

Snapshot construction and event replay still perform synchronous local SQLite work. Large-project latency, disk-full/power-loss behavior on target hardware, clean-machine recovery and a full implementation pilot remain release gates. rc.3 is a tested hardening release, not evidence that every production scale/SLO is validated.

References: [SQLite locking](https://sqlite.org/lockingv3.html), [WAL concurrency and local-host requirements](https://sqlite.org/wal.html), [renaming an open database](https://sqlite.org/howtocorrupt.html#_unlinking_or_renaming_a_database_file_while_in_use), [Windows file sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [Sysinternals Handle](https://learn.microsoft.com/en-us/sysinternals/downloads/handle).
