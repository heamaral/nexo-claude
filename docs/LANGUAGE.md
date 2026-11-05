# Language policy

Technical instructions, skills and generated project rules use English. Conversation follows the user's language. Card titles, descriptions, workflow labels and results follow project conventions or explicit user preference. Stable schema keys, IDs and tool names are never translated. Existing records and custom rules are preserved.

Instructions are scaffolded in `.claude/rules/nexo.md`, with the `/board` alias in `.claude/commands/board.md`. `.nexo/` stores data. English instructions do not require English project content.

The board interface, accessibility labels, runtime diagnostics, default workflow labels, documentation and example screenshots use English. Existing project records and custom workflows retain their saved language. A message catalog and locale selection remain separate future work; this release is English by default, not a multilingual UI.

## MCP naming

Claude names plugin tools `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`. Since both names are nexo, snapshot is `mcp__plugin_nexo_nexo__snapshot`. Some views render this as Plugin Nexo Nexo [snapshot]; the label alone does not mean duplicate execution or installation. The namespace is preserved to avoid breaking permissions and integrations. Renaming the server requires an explicit migration and does not guarantee how every client renders labels.

See [Claude plugin MCP naming](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers).
