# Data model and MCP API

Domain IDs accept up to 80 alphanumeric characters, `_` and `-`. Entity IDs are unique across all kinds within a project. Use a unique `commandId` per intent and reuse it only when retrying exactly the same request. `expectedVersion: 0` creates an entity; updates use the version read from `state`.

## Entities

| Entity   | Main fields                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Delivery | id, title, description, workflow[], status, result, revisionOf?                                                           |
| Task     | id, deliveryId, parentId?, teamId?, title, description, stageId, dependencies[], criteria[], blocker?, result, evidence[] |
| Team     | id, deliveryId, title, description, workspace, engine, maxAgents                                                          |

A workflow stage is `{id, name, phase: queued|active|review|done, gate?: string}`. Each delivery owns its workflow. Stages and gates may be added while it is open. A stage in use cannot be removed or have its meaning changed. To rename stages or add gates, update the complete workflow with the current delivery version.

`gate` describes a validation criterion. A workflow with a gate requires at least one commit SHA in the evidence for every completed card. There is no declarative engine that runs pipelines or interprets the gate text automatically. The planner and reviewer check the criterion and record evidence. For human approval, model a dependent approval card and keep it pending until a decision is received.

Accepted deliveries are immutable. `accept` requires all cards to be completed, a result, and no working agents. A new request creates a new delivery; `revisionOf` can link it to an earlier one.

## Tools

| Tool              | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| init              | Initialize the current project explicitly                         |
| state             | Authoritative state, versions, agents, conflicts and health       |
| command           | Validated, idempotent create/update/accept                        |
| claim             | Register an agent, scopes and lease; start a card when applicable |
| heartbeat         | Renew a live lease and update activity                            |
| release           | Remove an agent association without completing its card           |
| board_open        | Generate a one-time local login and open the browser              |
| search            | Local FTS5 search, up to 50 results                               |
| snapshot          | Flush a closed SQLite snapshot before committing                  |
| resolve_conflicts | Explicitly acknowledge reviewed losing events                     |

Example card creation:

```json
{
  "commandId": "request-api-1",
  "actor": "planner",
  "op": "create",
  "kind": "task",
  "id": "api",
  "expectedVersion": 0,
  "data": {
    "deliveryId": "recovery",
    "title": "Implement API",
    "stageId": "backlog",
    "dependencies": ["contract"],
    "criteria": ["Token cannot be reused"]
  }
}
```

`claim` returns a temporary token and a monotonically increasing fence per card. Never put tokens in descriptions, evidence, committed prompts or Git. Use the native IDs supplied by hooks and `sessionId` so automatic cleanup can work. `parentAgentId` supports an agent hierarchy. There is one executor; collaborators can participate with distinct scopes, and reviewers declare read-only work. Every registered agent counts toward capacity.

Scopes are explicit relative files/directories. `.` means the entire workspace. Globs, absolute paths and `..` are rejected. Overlapping writer scopes are blocked in the coordinator board. Write/Edit hooks check paths; shell behavior still depends on Claude permissions and adherence to declared scopes.

To complete work, update `stageId` to a done phase with `result`, `evidence` and the current `leaseToken`. The token is excluded from the event. Wait for other collaborators to release their claims. Expired leases cannot be renewed: read state, revalidate changes and obtain a new claim.

## Internal HTTP API

Loopback only. Tools use bearer authorization. The browser uses a one-time ticket and an HttpOnly SameSite Strict cookie and is read-only. Endpoints are not a stable public API: `/api/state`, `/api/events`, `/api/command`, `/api/claim`, `/api/heartbeat`, `/api/release`, `/api/snapshot`, `/api/hook`, `/api/resolve`. Never expose `server.json` to third-party pages.
