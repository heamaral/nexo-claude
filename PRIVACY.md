# Nexo data handling

Nexo is a local, open-source Claude Code plugin. The project maintainer does not operate a hosted Nexo application service, receive your board content through the plugin, or collect analytics or telemetry from Nexo installations.

## Local information

Nexo processes the project location, Claude lifecycle events, task and delivery content, agent and session identifiers, ownership claims, activity and completion evidence used to coordinate work. Content you or an agent supplies may contain names, email addresses or other personal information. Nexo does not require contact details to run.

Durable project history is stored in `.nexo/` event records and closed SQLite snapshots. Live databases, ownership credentials, leases and logs are kept in ignored local state. The native helper and Node caches are stored in Claude's plugin data directory. The authenticated board communicates with the coordinator over the local loopback interface.

Local history has no automatic retention deadline. You control local deletion, backups and whether project history is committed or pushed to a Git remote. Git commits, remote copies and backups can retain earlier content after a local edit or deletion. Review the data before sharing it, and do not put secrets in titles, descriptions, results or evidence. Ignored local state and runtime caches should not be committed.

## Optional local measurements and checks

Telemetry is disabled by default per project. When explicitly enabled, structured usage samples and coordination response metrics stay in ignored local SQLite. Provider counts and estimates are labeled separately. Nexo does not extract prompts, conversation history, tool outputs or credentials for measurements. The user can clear usage samples and metrics with the explicit telemetry_clear tool. Disabling collection does not automatically erase existing local records.

Trusted check adapters are disabled until a project config declares an executable and fixed arguments. They run in the configured project repository under a working lease, inherit the local environment and may perform the operations implemented by that trusted project command. Nexo discards check stdout/stderr and stores a local result attestation. Review check configuration before enabling it.

Closed execution summaries can be explicitly exported into Git history. They omit session identity, tokens, scopes, machine paths and live activity text. Checkpoints and aliases contain only content deliberately supplied by users or agents, not automatically captured conversations. Review them before sharing.

## Network requests and other tools

When a compatible private runtime is not cached, the launcher downloads the release-pinned Node artifact from the HTTPS host recorded in the bundled runtime manifest. This request exposes ordinary connection information such as your IP address and the requested artifact to that host. It does not upload project content. The compact bundled helper is extracted locally without a network request.

Claude Code sends information according to your Claude configuration and Anthropic's policies. Other tools, connectors, Git remotes, browser navigation and commands that you authorize can transmit information independently of Nexo. Nexo is coordination software, not a sandbox controlling those tools.

## Support and security

If you open a public issue, the information you include becomes public under GitHub's policies. Do not include private project data, prompts, tokens or logs containing secrets. Report vulnerabilities privately to the repository owner as described in [SECURITY.md](SECURITY.md).

Nexo is distributed under the [MIT license](LICENSE). This disclosure describes the current implementation; review release changes and your own environment before adoption.
