---
name: plan
description: Plan or execute a delivery with hierarchical cards, dependencies, gates and coordinated agents.
argument-hint: '<desired outcome>'
---

Requested outcome: $ARGUMENTS

1. Read `state`; if uninitialized, call `init` in this project.
2. Delegate planning to `nexo:planner` with the goal, limits and context IDs. Record the plan via MCP before execution. If delegation is unavailable, explicitly assume the planner role and follow its rules.
3. Accepted deliveries are immutable. New requests create a delivery, optionally linked by `revisionOf`. Continue open deliveries with existing IDs and versions.
4. Decompose outcomes through hierarchy; order execution through dependencies. Define measurable criteria and project-specific gates. Adapt workflow columns to context.
5. Teams belong to deliveries. Use independent sessions and worktrees for simultaneous writing teams. Delegate to `nexo:worker` and `nexo:reviewer` with taskId, teamId, parentAgentId, scopes and criteria. Each agent claims its card with its own native hook identity.
6. Respect project/team capacity and write conflicts. Never bypass permissions or silently enable experimental features. Nexo does not remove native Claude limits, including one native team per session.
7. Hooks renew leases around tools and release participation at response end. Heartbeat before TTL during long work without tools. SubagentStop does not complete a card. Record result/evidence using `command` with leaseToken before release.
8. Integrate and test the same commit; record its real SHA in gate evidence. Accept only with all cards complete and agents released. Report actual results and pending work.
9. Snapshot before committing history. Never edit SQLite, events or Claude internal tables manually.

Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.
