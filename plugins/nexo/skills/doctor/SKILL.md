---
name: doctor
description: Diagnose Nexo installation, event conflicts and project health.
disable-model-invocation: true
---

Read `state`: inspect healthError, snapshot, conflicts, lost-contact agents and capacity.
Snapshot publication is separate from live database health. `snapshot.lastError` means the last exported SQLite file needs attention; it must not be treated as loss of cards or agent leases. EPERM/EACCES/EBUSY can indicate a Windows reader/scanner denying file replacement; do not claim a specific process caused it without evidence. Automatic retries continue. Run `snapshot` before a commit and require success. Never delete the destination, live SQLite, WAL or ownership lock files to bypass a sharing violation. Upgrade the plugin and reload old clients for graceful per-directory daemon handoff; do not kill unrelated project processes.
For runtime diagnostics, use the configured Node executable with `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs doctor`; acquire a maintenance claim before shell tools in initialized projects. If conflicts prevent claims, use `state` and `resolve_conflicts` after reviewing losing events and their causal descendants.
Never print tokens or delete events. Explain both conflicting outcomes before resolution. Acknowledging losing events does not apply their patches: reapply intended content as a new versioned `command`, then `snapshot`. Rebuild binary SQLite conflicts from reconciled events; never silently select a branch as truth.

Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.
