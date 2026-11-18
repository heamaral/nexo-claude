import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(4000);
export const stageSchema = z
  .object({
    id,
    name: text.max(80),
    phase: z.enum(['queued', 'active', 'review', 'done']),
    gate: z.string().max(2000).optional(),
    checks: z.array(id).max(30).optional(),
  })
  .strict();
export const workflowSchema = z
  .array(stageSchema)
  .min(2)
  .max(30)
  .refine(
    (v) =>
      new Set(v.map((s) => s.id)).size === v.length &&
      v.some((s) => s.phase === 'done') &&
      v.some((s) => s.phase === 'queued'),
    'Unique stages with queued and done phases required',
  );
export type Stage = z.infer<typeof stageSchema>;
export const defaultWorkflow: Stage[] = [
  { id: 'backlog', name: 'Planned', phase: 'queued' },
  { id: 'doing', name: 'In progress', phase: 'active' },
  {
    id: 'review',
    name: 'Validation',
    phase: 'review',
    gate: 'Acceptance criteria and tests passed on the integrated version',
  },
  { id: 'done', name: 'Completed', phase: 'done' },
];
export const deliverySchema = z
  .object({
    id,
    title: text.max(200),
    description: z.string().max(12000).default(''),
    workflow: workflowSchema.default(defaultWorkflow),
    status: z.enum(['planned', 'active', 'accepted']).default('planned'),
    result: z.string().max(12000).default(''),
    revisionOf: id.optional(),
  })
  .strict();
export const taskSchema = z
  .object({
    id,
    deliveryId: id,
    parentId: id.optional(),
    teamId: id.optional(),
    title: text.max(200),
    description: z.string().max(12000).default(''),
    stageId: id.default('backlog'),
    dependencies: z.array(id).max(200).default([]),
    criteria: z.array(text).max(50).default([]),
    blocker: z.string().max(2000).optional(),
    waiting: z
      .object({
        reason: z.enum(['dependency', 'resource', 'integration', 'user-test', 'decision']),
        nextAction: text,
        owner: text.max(200),
        since: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    source: z
      .object({
        adapter: id,
        id: z.string().min(1).max(200),
        status: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    aliases: z.array(z.string().min(1).max(200)).max(50).optional(),
    resources: z.array(id).max(30).optional(),
    workType: z.enum(['research', 'implementation', 'integration']).optional(),
    checkpoint: z
      .object({
        goal: text,
        remaining: z.array(text).max(30),
        decisions: z.array(text).max(30).default([]),
        rejected: z.array(text).max(30).default([]),
        references: z.array(z.string().max(1000)).max(100).default([]),
        nextStep: text,
        sourceCommit: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
      })
      .strict()
      .optional(),
    result: z.string().max(12000).default(''),
    evidence: z
      .array(
        z.object({
          label: text,
          url: z.string().max(2000).optional(),
          commit: z
            .string()
            .regex(/^[a-f0-9]{7,64}$/)
            .optional(),
          repoId: id.optional(),
          checkId: id.optional(),
          runId: id.optional(),
          fingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'STALE']).optional(),
          scope: z.enum(['research', 'draft', 'integrated']).optional(),
          artifact: z.string().max(1000).optional(),
        }),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const teamSchema = z
  .object({
    id,
    deliveryId: id,
    title: text.max(200),
    description: z.string().max(4000).default(''),
    workspace: z.string().max(1000).default(''),
    engine: z.enum(['subagents', 'independent-session', 'native-team']).default('subagents'),
    maxAgents: z.number().int().min(1).max(32).default(3),
  })
  .strict();
export const kinds = ['delivery', 'task', 'team'] as const;
export type Kind = (typeof kinds)[number];
export type Entity = { kind: Kind; id: string; version: number; data: any; updatedAt: string };
export const commandSchema = z
  .object({
    commandId: id,
    actor: text.max(200),
    op: z.enum(['create', 'update', 'accept']),
    kind: z.enum(kinds),
    id,
    expectedVersion: z.number().int().nonnegative(),
    data: z.record(z.string(), z.unknown()).default({}),
    leaseToken: z.string().max(200).optional(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export const claimSchema = z
  .object({
    taskId: id,
    agentId: id,
    name: text.max(100),
    role: z.enum(['executor', 'collaborator', 'reviewer']).default('executor'),
    teamId: id.optional(),
    parentAgentId: id.optional(),
    sessionId: z.string().max(200).optional(),
    activity: z.string().max(500).default('Working'),
    scopes: z.array(z.string().min(1).max(500)).min(1).max(50),
    ttlSeconds: z.number().int().min(30).max(600).default(120),
    workspaceId: id.optional(),
    resources: z.array(id).max(30).default([]),
    executionId: id.optional(),
    parentExecutionId: id.optional(),
    model: z.string().max(100).optional(),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;
export type Agent = Claim & {
  token: string;
  fence: number;
  startedAt: number;
  expiresAt: number;
  state: 'working' | 'lost_contact';
};
export type Event = {
  schema: 1;
  projectId: string;
  id: string;
  parents: string[];
  at: string;
  command: Command;
  hash: string;
};
export class NexoError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function assert(ok: unknown, code: string, message: string, status = 409): asserts ok {
  if (!ok) throw new NexoError(code, message, status);
}
