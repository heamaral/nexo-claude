import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findProject, initialize } from './project.js';
import { board, ensureServer, request } from './client.js';
import { claimSchema, commandSchema } from './model.js';

const server = new McpServer(
  { name: 'nexo', version: '1.0.0-rc.1' },
  { maxToolInputElements: 20000 },
);
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
    description:
      'Authoritative project snapshot: deliveries, workflow, hierarchical cards, teams, active/lost-contact agents and merge conflicts. Read before planning or updating expectedVersion.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => request('state', undefined, root())),
);
server.registerTool(
  'command',
  {
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
    description:
      'Local SQLite FTS search across delivery, task and team titles/descriptions. Returns at most 50 results.',
    inputSchema: { query: z.string().max(200) },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => request('search?q=' + encodeURIComponent(a.query), undefined, root())),
);
server.registerTool(
  'snapshot',
  {
    description:
      'Flush a closed standalone SQLite snapshot before a Git commit. JSON events remain the merge/rebuild source. Never commit .nexo/local.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  wrap(async () => request('snapshot', {}, root())),
);
server.registerTool(
  'resolve_conflicts',
  {
    description:
      'Explicitly acknowledge losing events after reviewing each conflict and its causal descendants. This does not apply losing patches. Reapply intended content as a NEW versioned command after resolution; never guess which branch wins.',
    inputSchema: { eventIds: z.array(z.string().uuid()).min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  wrap(async (a) => request('resolve', a, root())),
);
await server.connect(new StdioServerTransport());
