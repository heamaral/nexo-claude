---
name: init
description: Initialize Nexo planning and the live board in the current project.
disable-model-invocation: true
---

Call MCP `init` for this project. It scaffolds `.nexo/project.json`, the event ledger, SQLite snapshot, English technical rules in `.claude/rules/nexo.md` and the `.claude/commands/board.md` alias, preserving existing files.
Call `board_open`. Explain that `.nexo/local/` is ignored by Git and durable project data can be committed. Preserve existing `/board` commands; `/nexo:board` remains available.
Do not grant global permissions, enable experimental Agent Teams or modify other projects.

Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.
