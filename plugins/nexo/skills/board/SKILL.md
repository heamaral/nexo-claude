---
name: board
description: Open the current project live Nexo board in the browser.
disable-model-invocation: true
---

Call `mcp__plugin_nexo_nexo__board_open` with `openBrowser: true`.
If uninitialized, explain that `/nexo:init` initializes this project. Never initialize another repository by mistake.
Report the board launch; if automatic launch fails, return the temporary URL. Never read or display tokens from `.nexo/local/`.

Respond in the user's language unless explicitly asked otherwise. Preserve the language of existing project content; use the project's established language or the user's explicit preference for new records. Never translate stable IDs, schema keys, paths or code merely to match these English instructions.
