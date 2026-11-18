# Security review guide

Nexo is a local Claude Code plugin. Its command hooks and local stdio MCP server require an Anthropic Verified publisher organization for directory distribution. Native code and files over the directory's automatic inspection limits require human review. This package does not remove those features or disguise executable payloads to avoid review.

Readable application and native bootstrap sources are included under `source/`. The entry points are `source/src/mcp.ts`, `source/src/cli.ts`, `source/src/server.ts`, and `source/bootstrap/main.go`. The compressed native helpers are executable payloads, not source. The browser application is bundled without minification.

The public repository includes exact dependency pins and lockfile, Go sources, build scripts and CI. `pnpm build` regenerates the application bundle and these source copies. `pnpm build:bootstrap`, using Go 1.27.3, regenerates the six platform helpers/loaders and integrity manifest. CI rebuilds artifacts and rejects a changed runtime/bootstrap tree. Runtime archives and binaries are SHA-256 pinned in `bootstrap/runtime-manifest.json`; helper hashes and sizes are in `bootstrap/helper-manifest.json`. Downloaded Node is private to the plugin cache and is never added to the user's PATH.

The first runtime preparation downloads only the pinned Node distribution from the documented Node distribution origin. Application code and the browser board are bundled. There is no remote project database, telemetry collector or background marketing service. Browser authentication is loopback-only, with one-time tickets and read-only cookies. Leases, tokens, usage metrics, check attestations and logs remain under ignored `.nexo/local`.

Hooks keep lifecycle metadata, not tool results or conversation text. Pre-write checks require explicit task ownership; shell execution remains governed by Claude's permissions and is not presented as a filesystem sandbox. Optional trusted test adapters execute only reviewed project configuration, without evaluating card gate text. They are disabled until configured by the project owner.

For a clean review: install the plugin, initialize an empty fixture with `/nexo:init`, ask the planner to create a delivery with two independent child cards and an integration prerequisite, and open `/board`. Claim and release one card to observe live presence. Attempt a conflicting writer to observe denial. Finish cards with explicit evidence and inspect accepted delivery history. The repository's `tests/efficiency.test.mjs` and native `hooks_test.go` cover focused context, rollback, resource contention, recovery, large payload projection and exact-commit check attestations.

Source: https://github.com/heamaral/nexo-claude
Support: https://github.com/heamaral/nexo-claude/issues
Privacy: https://github.com/heamaral/nexo-claude/blob/main/PRIVACY.md

Directory verification and human review must be completed by Anthropic. A passing local test or reproducible build is not a claim of directory approval or a security audit.
