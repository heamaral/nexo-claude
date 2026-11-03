/** A deterministic layered DAG layout. Composition is separate from execution order. */
export type GraphNode = { id: string; kind: 'task' | 'external' | 'delivery' };
export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: 'dependency' | 'hierarchy' | 'delivery';
};
export type GraphTask = { id: string; data: { parentId?: string; dependencies: string[] } };
export type GraphMode = 'flow' | 'hierarchy';
export const NODE_WIDTH = 220,
  NODE_HEIGHT = 176,
  COLUMN_GAP = 76,
  ROW_GAP = 28,
  PADDING = 32;

export function buildGraph(tasks: GraphTask[], deliveryId: string, mode: GraphMode) {
  // Namespace the virtual delivery node: task IDs may equal arbitrary display strings.
  const goalId = '@delivery:' + deliveryId;
  const nodes = new Map<string, GraphNode>(tasks.map((t) => [t.id, { id: t.id, kind: 'task' }]));
  nodes.set(goalId, { id: goalId, kind: 'delivery' });
  const edges = new Map<string, GraphEdge>();
  const add = (from: string, to: string, kind: GraphEdge['kind']) => {
    const key = JSON.stringify([from, to]);
    if (from === to) return;
    // An explicit dependency takes precedence over a redundant composition line.
    if (!edges.has(key) || kind === 'dependency') edges.set(key, { id: key, from, to, kind });
  };
  for (const task of tasks) {
    const parent = task.data.parentId;
    if (mode === 'flow') {
      for (const dependency of task.data.dependencies) {
        if (!nodes.has(dependency)) nodes.set(dependency, { id: dependency, kind: 'external' });
        add(dependency, task.id, 'dependency');
      }
      if (parent && nodes.has(parent)) add(task.id, parent, 'hierarchy');
    } else add(parent && nodes.has(parent) ? parent : goalId, task.id, 'hierarchy');
  }
  if (mode === 'flow') {
    const hasOutgoing = new Set([...edges.values()].map((e) => e.from));
    const terminals = tasks.filter((task) => !hasOutgoing.has(task.id));
    if (terminals.length === 1) nodes.delete(goalId);
    else for (const task of terminals) add(task.id, goalId, 'delivery');
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], goalId };
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, [] as string[]]));
  const outgoing = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of edges)
    if (byId.has(e.from) && byId.has(e.to)) {
      incoming.get(e.to)!.push(e.from);
      outgoing.get(e.from)!.push(e.to);
    }
  const degree = new Map([...incoming].map(([id, list]) => [id, list.length]));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes
    .filter((n) => !degree.get(n.id))
    .map((n) => n.id)
    .sort();
  for (let i = 0; i < queue.length; i++)
    for (const target of outgoing.get(queue[i])!) {
      depth.set(target, Math.max(depth.get(target)!, depth.get(queue[i])! + 1));
      degree.set(target, degree.get(target)! - 1);
      if (!degree.get(target)) queue.push(target);
    }
  const cyclic = nodes.filter((n) => degree.get(n.id)! > 0).map((n) => n.id);
  // Keep malformed imported data inspectable, without recursion or fabricated links.
  const maxDepth = Math.max(0, ...depth.values());
  for (const id of cyclic) depth.set(id, maxDepth + 1);
  // Reserve invisible lanes for skipped layers, so long edges do not pass through cards.
  const routing = new Map<string, string[]>(),
    allIds = nodes.map((n) => n.id);
  const expandedIncoming = new Map(allIds.map((id) => [id, [] as string[]]));
  const expandedOutgoing = new Map(allIds.map((id) => [id, [] as string[]]));
  let virtualCount = 0;
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const start = depth.get(edge.from)!,
      end = depth.get(edge.to)!;
    const via: string[] = [];
    if (end - start > 1 && end - start <= 12 && virtualCount < 2000) {
      for (let layer = start + 1; layer < end; layer++) {
        const id = '@lane:' + virtualCount++;
        allIds.push(id);
        depth.set(id, layer);
        via.push(id);
        expandedIncoming.set(id, []);
        expandedOutgoing.set(id, []);
      }
    }
    routing.set(edge.id, via);
    const chain = [edge.from, ...via, edge.to];
    for (let i = 1; i < chain.length; i++) {
      expandedIncoming.get(chain[i])!.push(chain[i - 1]);
      expandedOutgoing.get(chain[i - 1])!.push(chain[i]);
    }
  }
  const layers: string[][] = [];
  for (const id of allIds) (layers[depth.get(id)!] ??= []).push(id);
  for (const layer of layers) layer?.sort();
  // Barycentric sweeps reduce branch crossings while retaining deterministic order.
  const rank = new Map<string, number>();
  const ranks = () => {
    for (const layer of layers) layer?.forEach((id, i) => rank.set(id, i));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    ranks();
    const forward = sweep % 2 === 0;
    const order = forward ? layers : [...layers].reverse();
    for (const layer of order)
      if (layer) {
        const average = (id: string) => {
          const adjacent = (forward ? expandedIncoming : expandedOutgoing).get(id)!;
          return adjacent.length
            ? adjacent.reduce((sum, n) => sum + (rank.get(n) ?? 0), 0) / adjacent.length
            : rank.get(id)!;
        };
        const scores = new Map(layer.map((id) => [id, average(id)]));
        layer.sort((a, b) => scores.get(a)! - scores.get(b)! || a.localeCompare(b));
        layer.forEach((id, i) => rank.set(id, i));
      }
  }
  const rows = Math.max(1, ...layers.map((layer) => layer?.length ?? 0));
  const positions = new Map<string, { x: number; y: number; layer: number }>();
  layers.forEach((layer, column) =>
    layer?.forEach((id, row) =>
      positions.set(id, {
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + ((rows - layer.length) / 2 + row) * (NODE_HEIGHT + ROW_GAP),
        layer: column,
      }),
    ),
  );
  return {
    positions,
    width: PADDING * 2 + Math.max(1, layers.length) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: PADDING * 2 + rows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP,
    cyclic,
    routes: new Map([...routing].map(([id, via]) => [id, via.map((v) => positions.get(v)!)])),
  };
}
