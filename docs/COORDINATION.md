# Focused coordination and verified delivery

Nexo 1.1 introduces focused context, execution attempts and explicit operational policies. Nothing in this guide automatically rewrites another project's rules, imports its manifest, launches teams or changes its model settings.

## Read what the agent needs

`state` now returns a compact project overview. Use `state(full=true)` or `query(view=export)` only for an intentional full export. The legacy authenticated HTTP `/api/state` endpoint remains available for board compatibility.

- Workers: `query({view:"task",id:"task-id"})` returns criteria, ancestors, prerequisites, child summaries, ownership, checkpoint and gate status.
- Planners: `query({view:"delivery",id:"delivery-id",limit:30})` returns a page of versioned records. Continue with `nextCursor` until `complete` is true.
- Recovery: `query({view:"assignment",id:"native-agent-id",sessionId:"native-session-id"})` identifies current or expired ownership. Claim returns the secret lease; queries never return it.
- Retrieval: `query({view:"search",query:"src/wind.ts"})` matches exact IDs, aliases, evidence references and checkpoint paths in addition to SQLite FTS title/description results. Add `kind`, `deliveryId` or `stageId` filters. Use `section` and `nextCursor` to page a task's criteria, children, dependencies, evidence or checkpoint references when the full context exceeds the budget. Add translated aliases explicitly when useful; no external embedding service or vector database is required.
- Fields: request `description`, `criteria`, `evidence`, `checkpoint`, `result`, `dependencies` or `source` only when needed.
- Incremental clients: `query({view:"changes",sinceRevision:42})` uses the durable revision and returns changed entities. A server instance change, history reset or exceeded budget requires a fresh read. Always carry `instance` together with the revision. The board checks both automatically.

The default response budget is 24,000 UTF-8 bytes; `maxBytes` ranges from 2,048 to 65,536. Oversized records return an explicit indication and a narrower-read recommendation. Never infer that omitted fields, children or prerequisites do not exist. Explicit exports are intentionally unbounded. Diagnostic detail may need an explicit larger budget or focused request. Byte reduction is not a measured token-cost reduction.

## Ownership and execution attempts

An identical working claim for the same session, task, role, team, workspace, execution and scopes reuses the lease and fencing value. A changed claim returns `AGENT_ACTIVE` with recovery information. Expired claims never revive; a fresh claim gets a higher fence and a new execution ID. Heartbeat HTTP/MCP replies contain only identity, fence, expiry and state.

Claims can record `executionId`, `parentExecutionId`, `model`, `effort`, `workspaceId` and `resources`. Nexo does not invent model or token information. The useful hierarchy is delivery, outcome card, work package, execution attempt. A grep or file read is activity inside an attempt, not another card. `query(view=executions,id=taskId)` shows attempt history.

Closed attempt summaries can be explicitly exported with `executions_export`. These immutable `.nexo/executions/*.json` files contain project/task/execution relationships, timestamps, status and optional model/effort. They omit session identity, tokens, activity text, machine paths, scopes and live heartbeats. Local detailed attempt records remain in ignored SQLite. Copied summaries are inspectable historical artifacts; they do not restore ownership or local check attestations on another machine.

Hooks project JSON metadata as a stream rather than buffering tool results. Only IDs, event, tool name, workspace and a direct write path reach the coordinator. Images and command output are discarded, with a 256 MiB input ceiling, 128-level nesting ceiling and bounded metadata strings. Post hooks match only relevant write/shell tools, including failures. Failed bookkeeping cannot retroactively veto a finished tool. Pre-write hooks remain fail closed. Repeated post events are deduplicated by session, actor, event and tool-use ID; a rejected pre-tool request is never cached as permission.

Stop and SubagentStop can be vetoed by another hook. Ownership therefore ends through explicit `release`, final `SessionEnd`, `StopFailure`, completion or bounded expiry, rather than an unconfirmed Stop notification. Checkpoint before long tools and renew before TTL. A tool can outlive its lease; subsequent writes require recovered ownership. Claims and hooks are coordination, not an OS filesystem sandbox.

## Task stage, waiting and checkpoints

Stage is the delivery's workflow position. Execution is who currently owns it. Verification is evidence bound to source. Waiting describes an external next action. These are separate dimensions.

```json
{
  "waiting": {
    "reason": "user-test",
    "nextAction": "Validate the integrated scene in the Unity editor",
    "owner": "Project owner",
    "since": "2026-11-18T12:00:00Z"
  },
  "checkpoint": {
    "goal": "Finish wind integration",
    "remaining": ["Editor acceptance"],
    "decisions": ["Preserve measured behavior"],
    "rejected": ["Unverified constant substitutions"],
    "references": ["Assets/Wind/WindField.cs", "docs/wind-acceptance.md"],
    "nextStep": "Run the integrated acceptance gate"
  }
}
```

Waiting reasons are `dependency`, `resource`, `integration`, `user-test`, or `decision`. Clear waiting with `waiting:null`; stages never reset automatically on release. Waiting tasks cannot be claimed or completed. Checkpoints and aliases are durable user-selected context, not captured conversation transcripts. Reference existing Cartographer/codegraph indexes instead of duplicating them.

## Explicit project configuration

Optional versioned `.nexo/coordination.json` is strict, bounded JSON. It contains no credentials. Review it as executable project policy before enabling a check adapter. No configuration is inferred from a card's prose.

```json
{
  "schema": 1,
  "telemetry": false,
  "resources": [
    { "id": "unity-editor", "capacity": 1 },
    { "id": "wsl-gate", "capacity": 2 },
    { "id": "figma-registry", "capacity": 1, "owner": "Project owner" }
  ],
  "repositories": [{ "id": "game", "path": ".", "integratedRef": "HEAD" }],
  "checks": [
    {
      "id": "acceptance",
      "repoId": "game",
      "artifact": ".nexo/local/checks/acceptance.json",
      "executable": "node",
      "args": ["scripts/acceptance.mjs"],
      "timeoutSeconds": 120,
      "resourceId": "wsl-gate"
    }
  ],
  "adapters": [
    {
      "id": "q9",
      "path": "docs/task-manifest.json",
      "stageMap": { "Todo": "backlog", "Doing": "doing", "Done": "done" }
    }
  ],
  "externalWrites": []
}
```

The example's executable belongs to the project's trusted test environment; Nexo does not install project toolchains. Node in this example is not Nexo's runtime requirement. Use the appropriate explicit executable path for that project's checks.

`schedule` returns a paginated advisory queue, ranking ready work by downstream prerequisites, ownership, waits and resource availability. Claims atomically enforce configured resource capacities as well as existing project/team/scoped write limits. A resource with `owner` remains reserved for that person until explicitly changed. Native Claude session/team capacity remains a separate ceiling. The scheduler never starts a process or assigns a model.

An `externalWrites` entry is `{resourceId,path}`. A claim must hold that configured resource to write in the explicit external directory. This is a narrow opt-in for shared registries or session-memory outputs, with existing symlink checks; it is never a blanket HOME exemption. Shell commands retain their normal Claude permission controls.

## Verified checks

Free-text `gate` remains descriptive. For enforcement, add `checks:["acceptance"]` to a workflow stage. Completing implementation/integration cards then requires PASS evidence for each configured check. Legacy workflows without `checks` retain their existing recorded-evidence requirement and are labeled accordingly, not upgraded to verified PASS.

`run_check({checkId,taskId,token})` runs only the fixed executable and arguments from reviewed configuration, with no shell interpolation or card text. It requires a working task lease and any configured resource. It binds the result to a full commit in the configured repository, a clean tracked worktree and the configured integrated ref. A changed commit, tracked edit, lost lease, nonzero exit or timeout cannot yield an integrated PASS. Tool stdout/stderr is discarded rather than captured into the agent context. Check processes inherit the trusted project's environment; configure only commands the user intends to run. The check timeout bounds the direct child process; this is not a descendant-process or network sandbox.

The coordinator writes a local bounded result artifact with repoId, commit, checkId, runId, status and adapter fingerprint. Evidence also records the artifact SHA-256. An asynchronous preflight re-verifies repository identity, commit/ref, tracked cleanliness, artifact identity/hash, adapter configuration and a local attestation proving this coordinator ran the check. The following SQLite transaction checks the exact command, policy, optimistic versions and ownership against that short-lived proof. Git verification does not block heartbeats. External repository mutations are outside the SQLite transaction; checks attest the source observed during verification. Manually writing PASS into a card is insufficient. A clone needs a new check run before new acceptance; imported historical events remain replayable without running tests.

`workType:"research"` permits explicitly labeled research evidence without pretending it is integrated implementation proof. Delivery acceptance still requires all cards complete and rechecks implementation/integration gates. Keep at least one appropriate integrated acceptance task for an implementation delivery.

## Worktrees and project movement

Register a worktree using `workspace({id,path,mode:"isolated",coordination:"shared",expectedProjectId})`. Nexo verifies its Git common directory, records branch/base commit and writes a local coordinator link into the worktree's private Git directory. Discovery follows that explicit link before tracked `.nexo` files, avoiding accidental split boards. Direct writes require the effective workspace to match the claim's registered workspace. Overlap checks compare physical workspace paths, so multiple IDs cannot bypass ownership in the same checkout. Separate worktrees can have concurrent writers with equal relative paths.

Use `NEXO_PROJECT_ROOT` for the canonical coordinator and `NEXO_WORKSPACE` for the effective worktree in explicitly launched sessions. A missing/moved coordinator or changed identity requires re-registration; Nexo does not silently create a substitute. Independent coordination is explicit and requires a separately initialized board with its own project identity. Nexo never deletes copied history to manufacture one. `mode:"shared"` denotes the coordinator checkout; `mode:"isolated"` denotes a separate Git worktree. `coordination` controls which board owns it.

## Imports and reconciliation

`batch({jobId,preview:true,commands})` validates up to 100 ordered commands in one transaction and rolls back, including entities, events and execution changes. The preview never exports an outbox event. Review it, then apply with `preview:false`. One invalid command rolls back the whole batch. Stable job IDs and command IDs make retries and multi-batch jobs resumable. Parents and prerequisites must precede references; existing optimistic versions, cycles, leases, source/evidence and acceptance constraints remain enforced.

Cards can carry `source:{adapter,id,status}`. `reconcile({adapterId})` reads the explicitly configured JSON manifest, which is either an array or `{tasks:[...]}` with stable `id` and `status` fields. It normalizes statuses through `stageMap`, reports missing/ambiguous IDs and stage differences, and returns the manifest fingerprint. Other source fields stay in that manifest. Specialized schemas can export this adapter format. No reconciliation request changes either source. Synchronization is a separately reviewed set of ordinary versioned commands, optionally previewed/applied in bounded batches. Never bulk mark Done merely to match a manifest.

## Local measurements and board behavior

Telemetry is opt in per project. `usage` accepts structured provider counts or explicitly marked estimates per execution: input, cache creation/read, output, category, latency and response bytes. Provider and estimated aggregates remain separate. HTTP coordination metrics count response bytes, duration and status locally, including hook errors. Nexo does not extract chat history, prompts, files or credentials for telemetry, does not infer billing, and sends no measurements to a remote service. `telemetry_clear` deletes local usage/metrics on explicit request. Disable telemetry to stop collection; ignored local state follows the project's own backup/retention policy.

The board receives small presence events for leases and card deltas for durable changes. Graph layout depends on topology rather than presence. Reconnection or history reset falls back to a full board read. The coordination modal shows runtime/canonical root, snapshot state, lost contact, resources, waiting action owners, check freshness, worktrees and delivery readiness. Cards show waits and task modals show checkpoints and attempt history.

## Upgrade and validation

Upgrade the marketplace/plugin and reconnect Claude sessions together. Existing project rules are intentionally not overwritten; opt in to the new guidance explicitly. New optional task fields and check policies require Nexo 1.1 on every writer. Older clients/daemons may reject those records; do not keep old sessions writing a project after adopting them. Snapshot publication, event reconciliation, fencing and local-only secrets remain unchanged.

Regression fixtures reproduce the audit's scale and failure modes using synthetic content, not private Q9/MU conversations or project files. Byte-size comparisons measure transport volume, not token billing or whole-project speedup. Real project acceptance and Anthropic directory approval remain separate from automated release tests.
