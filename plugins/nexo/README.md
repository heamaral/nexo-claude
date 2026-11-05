# Nexo

Local delivery planning, hierarchical tasks, dependency graphs and live agent ownership for Claude Code.

Requires Claude Code 2.1.316 or later and Git on Windows, macOS or glibc Linux (x64/ARM64). No Node installation or configuration is required: the native launcher automatically downloads and verifies a private pinned runtime on first use, then reuses it offline. Global Node and PATH are unchanged. Install the marketplace with /plugin marketplace add heamaral/nexo-claude, then /plugin install nexo@nexo-marketplace. In a project, run /nexo:init, /nexo:plan and /board.

Release candidate 1.0.0-rc.7. The native launchers, application code and browser UI are bundled; the first Node runtime download requires internet access. The UI uses English; agents respond in the user's language. Read the repository README, managed runtime guide, security boundaries and release criteria before adoption.

Licensed under MIT. Third-party licenses are preserved in runtime/THIRD_PARTY_NOTICES.md, bootstrap/THIRD_PARTY_NOTICES.md and the downloaded runtime's LICENSE.
