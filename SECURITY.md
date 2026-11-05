# Security

Nexo is a local service for a trusted operating-system user, not a network-exposed collaboration service.

- HTTP binds to `127.0.0.1`, validates Host/Origin and rejects cross-site requests.
- The MCP runtime uses the bearer token stored in `.nexo/local/`.
- The browser receives a 60-second, one-time ticket and exchanges it for an HttpOnly SameSite Strict cookie. The URL fragment is removed from browser history.
- Browser sessions last eight hours and are invalidated on service restart.
- The board is read-only. Commands, claims and conflict resolution require bearer authorization, not a browser cookie.
- CSP, no CDNs, React text escaping, request size limits and parameterized SQL reduce attack surfaces.
- Nexo does not execute code supplied in cards, event files or evidence URLs.
- Hooks use exec-form argument arrays without evaluating them through a shell. The session helper does not bypass permissions.
- Review project `.nexo/` data and `.claude/` files before running plugins in an untrusted repository.

Leases coordinate work. They do not isolate processes belonging to the same user, prevent edits in other editors, or establish scope compliance for arbitrary shell commands. Write/Edit hooks check relative scopes and reject symlinks; shell tools require a claim and remain subject to normal Claude permissions. Reviewers should not run commands that write.

Local files use restricted permissions where supported. On Windows, effective protection depends on inherited directory ACLs. Do not place local state in directories shared with untrusted users. Never commit tokens. SQLite snapshots are binary Git files; event records are not encrypted. Do not put secrets in titles, results or evidence.

Report vulnerabilities privately to the repository owner. Do not open public issues containing tokens, sensitive prompts or private project content.

The native bootstrap downloads only release-pinned Node artifacts from the bundled manifest over HTTPS with OS certificate trust. It verifies archive and extracted executable SHA-256 digests, rejects unsafe archive paths, bounds extraction and checks SQLite before activation. Cached executable digests are checked on reuse. The plugin distribution and manifest are part of the trust boundary: replacing both defeats checksum protection. Native binaries are rebuilt and compared in CI; they are not separately Authenticode-signed or Apple-notarized. Respect OS and organizational execution policies rather than disabling them.

Managed dependencies live in Claude's private plugin data, outside project Git data. Installation uses OS-owned locks and immutable generations, preserving executables used by running processes. The cache is not a sandbox against another process running as the same OS user. Ambient NODE_OPTIONS and NODE_PATH are removed from private Node subprocesses. The optional NEXO_NODE_PATH expert override executes a user-selected compatible binary instead of the pinned one; only configure it with a trusted executable. See [runtime operation](docs/RUNTIME.md).
