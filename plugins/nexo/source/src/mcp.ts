import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findProject, initialize } from './project.js';
import { board, ensureServer, request } from './client.js';
import { claimSchema, commandSchema } from './model.js';
import { VERSION } from './version.js';
import {
  querySchema,
  batchSchema,
  workspaceSchema,
  usageSchema,
  runCheckSchema,
} from './coordination.js';

const server = new McpServer({ name: 'nexo', version: VERSION }, { maxToolInputElements: 20000 });
const root = () =>
  findProject(process.env.NEXO_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const wrap = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
  try {
    const value = await fn(args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
  }
};
server.registerTool(
  'init',
  {
    title: 'Nexo init',
    description:
      'Explicitly initialize Nexo in the current project. directoryMode=repository uses Git root; directory creates an independent nested/monorepo board in the current directory. Does not overwrite existing rules.',
    inputSchema: {
      name: z.string().min(1).max(200).optional(),
      directoryMode: z.enum(['repository', 'directory']).default('repository'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  wrap(async (a) => {
    const result = initialize(
      process.env.NEXO_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      a.name,
      { exact: a.directoryMode === 'directory' },
    );
    await ensureServer(result.root);
    return result;
  }),
);
server.registerTool(
  'state',
  {
    title: 'Nexo state',
    description:
      'Compact project overview. Prefer query(view=task,id=...) for workers or query(view=delivery,id=...) for planners. Explicit full=true exports the entire board and can be large.',
    inputSchema: { full: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => request('query', { view: a.full ? 'export' : 'summary' }, root())),
);
for (const [name, description, inputSchema, route, readOnly] of [
  [
    'query',
    'Bounded project queries: summary, task context, delivery page, assignment recovery, search by ID/path/alias, changes since durableRevision, diagnostics, execution history, explicit export. Preserve versions; page with nextCursor. maxBytes is an output budget. Never treat omitted data as absent.',
    querySchema,
    'query',
    true,
  ],
  [
    'batch',
    'Preview and atomically apply up to 100 ordered versioned commands. Default preview=true rolls back all changes. Review before preview=false. Stable jobId and commandIds support resumable imports across batches. Preserve source IDs/status, hierarchy, dependencies and evidence.',
    batchSchema,
    'batch',
    false,
  ],
  [
    'schedule',
    'Advisory ready queue ranked by downstream dependencies, capacity and explicit resource locks. Does not launch agents. Native Claude limits remain separate. Paginate with query.limit/cursor/maxBytes.',
    z.object({ deliveryId: z.string().optional(), query: querySchema.optional() }),
    'schedule',
    true,
  ],
  [
    'workspace',
    'Explicitly register a Git worktree against a canonical project identity. Records branch/base commit and diagnoses split boards. Set NEXO_PROJECT_ROOT to coordinator and NEXO_WORKSPACE to the registered directory; include workspaceId when claiming.',
    workspaceSchema,
    'workspace',
    false,
  ],
  [
    'reconcile',
    'Read-only manifest adapter comparison. Configure adapter path and normalized stageMap first. Reports missing/ambiguous IDs and source status differences. Synchronization requires explicit reviewed versioned commands, optionally batch preview.',
    z.object({ adapterId: z.string() }),
    'reconcile',
    true,
  ],
  [
    'usage',
    'Opt-in local structured usage sample per execution, idempotent by ID. Provider counts and estimates remain labeled. No prompts, credentials, automatic billing or external telemetry.',
    usageSchema,
    'usage',
    false,
  ],
  [
    'run_check',
    'Run an explicitly configured trusted check executable with fixed arguments, under a live task lease and optional resource lock. No shell interpolation or card gate prose. Binds a local check attestation to the exact clean integrated commit; returns structured PASS/FAIL/STALE evidence. Configure only commands the user trusts.',
    runCheckSchema,
    'run-check',
    false,
  ],
  [
    'telemetry_clear',
    'Delete local usage samples and coordination metrics on explicit user request. Does not delete tasks, evidence or execution records. Disable telemetry in project config to stop future samples.',
    z.object({}),
    'telemetry-clear',
    false,
  ],
  [
    'executions_export',
    'Explicitly export closed sanitized execution summaries to versioned .nexo/executions. Excludes tokens, session identity, activity text, machine paths and live heartbeat state.',
    z.object({}),
    'executions-export',
    false,
  ],
] as const)
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        title: 'Nexo ' + name.replaceAll('_', ' '),
        readOnlyHint: readOnly,
        destructiveHint: name === 'telemetry_clear',
        openWorldHint: name === 'run_check',
      },
    },
    wrap(async (a) => request(route, a, root())),
  );
server.registerTool(
  'command',
  {
    title: 'Nexo command',
    description:
      'Create/update delivery, task or team; accept a delivery. Explicit commandId is idempotent; expectedVersion prevents overwrites. Create expectedVersion=0. Completed tasks require result + evidence (commit for gated workflows), resolved dependencies/children/blockers; leaseToken required for claimed tasks. Accepted delivery is immutable. Workflow is an array of {id,name,phase:queued|active|review|done,gate?}. Task fields: deliveryId,title,parentId?,teamId?,stageId,dependencies[],criteria[],blocker?,result,evidence:[{label,commit?,url?}]. Team: deliveryId,title,engine,workspace,maxAgents. Delivery: title,description,workflow,status,result,revisionOf?. Clear blocker using empty string.',
    inputSchema: commandSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  wrap(async (a) => request('command', a, root())),
);
server.registerTool(
  'claim',
  {
    title: 'Nexo claim',
    description:
      'Register an agent on a card before work. Use native agentId and sessionId from hook context. Returns secret ephemeral lease token + monotonic fencing value. One executor per card; collaborators explicit; reviewers read only. Scopes are explicit relative files/directories, no globs. Overlapping writers and capacity excess are rejected. Claim moves queued task into active stage. Heartbeat before TTL, default 120s, max 600s.',
    inputSchema: claimSchema,
    annotations: { readOnlyHint: false },
  },
  wrap(async (a) => request('claim', a, root())),
);
server.registerTool(
  'heartbeat',
  {
    title: 'Nexo heartbeat',
    description:
      'Renew your active lease and describe current work. Expired lease cannot be revived: re-read state and claim a new execution.',
    inputSchema: { token: z.string(), activity: z.string().max(500).optional() },
    annotations: { readOnlyHint: false },
  },
  wrap(async (a) => request('heartbeat', a, root())),
);
server.registerTool(
  'release',
  {
    title: 'Nexo release',
    description:
      'Remove an agent from the active card collection. Does not complete the card. Safe to repeat.',
    inputSchema: { token: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  wrap(async (a) => request('release', a, root())),
);
server.registerTool(
  'board_open',
  {
    title: 'Nexo board open',
    description:
      'Open the current project live board in the default browser. One-time local authentication; no cloud service. Use for /board or /nexo:board.',
    inputSchema: { openBrowser: z.boolean().default(true) },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  wrap(async (a) => board(root(), a.openBrowser)),
);
server.registerTool(
  'search',
  {
    title: 'Nexo search',
    description:
      'Compact local search across IDs, paths, aliases, evidence references and SQLite FTS titles/descriptions. Returns a bounded page; continue with cursor.',
    inputSchema: {
      query: z.string().max(200),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => request('query', { view: 'search', ...a }, root())),
);
server.registerTool(
  'snapshot',
  {
    title: 'Nexo snapshot',
    description:
      'Flush a closed standalone SQLite snapshot through the durable generation visible at invocation before a Git commit. Concurrent requests share a publisher; transient file-sharing errors retry with a deadline. Failure preserves the live SQLite/outbox and last complete snapshot; inspect state.snapshot and retry before committing. Quiesce project changes for a commit that requires the latest generation. JSON events remain the merge/rebuild source. Never commit .nexo/local.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  wrap(async () => request('snapshot', {}, root())),
);
server.registerTool(
  'resolve_conflicts',
  {
    title: 'Nexo resolve conflicts',
    description:
      'Explicitly acknowledge losing events after reviewing each conflict and its causal descendants. This does not apply losing patches. Reapply intended content as a NEW versioned command after resolution; never guess which branch wins.',
    inputSchema: { eventIds: z.array(z.string().uuid()).min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  wrap(async (a) => request('resolve', a, root())),
);
await server.connect(new StdioServerTransport());
