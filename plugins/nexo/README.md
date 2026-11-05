# Nexo

Local delivery planning, hierarchical tasks, dependency graphs and live agent ownership for Claude Code.

Requires Claude Code 2.1.316 or later and Git on Windows, macOS or glibc Linux (x64/ARM64). No Node installation or configuration is required: the native launcher automatically downloads and verifies a private pinned runtime on first use, then reuses it offline. Global Node and PATH are unchanged. Install the marketplace with /plugin marketplace add heamaral/nexo-claude, then /plugin install nexo@nexo-marketplace. In a project, run /nexo:init, /nexo:plan and /board.

Release candidate 1.0.0-rc.7. The native launchers, application code and browser UI are bundled; the first Node runtime download requires internet access. The UI uses English; agents respond in the user's language. Read the repository README, managed runtime guide, security boundaries and release criteria before adoption.

## Data handling

Nexo reads the project location, Claude lifecycle events, task content, agent identifiers and completion evidence needed for coordination. User-supplied content can include names or other personal data. It stores project history locally in `.nexo/` event files and closed SQLite snapshots; live leases, credentials and logs stay in ignored local state. Local history has no automatic retention deadline. You control deletion, backups and whether to commit or push that history with your repository. Do not put secrets in cards or evidence.

Nexo has no hosted application service, analytics or telemetry. Its board and coordinator communicate over the local loopback interface. Initial runtime preparation contacts the pinned Node distribution host over HTTPS; that download does not upload project content. Claude Code and any tools you separately authorize have their own data handling. See [the full disclosure](https://github.com/heamaral/nexo-claude/blob/main/PRIVACY.md) and [security boundaries](https://github.com/heamaral/nexo-claude/blob/main/SECURITY.md).

Licensed under MIT. Third-party licenses are preserved in runtime/THIRD_PARTY_NOTICES.md, bootstrap/THIRD_PARTY_NOTICES.md and the downloaded runtime's LICENSE.
