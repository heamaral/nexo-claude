import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, layoutGraph, NODE_WIDTH, NODE_HEIGHT } from '../src/web/graph-layout.ts';
const t = (id, dependencies = [], parentId) => ({ id, data: { dependencies, parentId } });
test('branching and joining tasks form a layered DAG, without repeating prerequisite cards', () => {
  const tasks = [
    t('contract'),
    t('tokens', ['contract']),
    t('email', ['contract']),
    t('api', ['tokens']),
    t('audit', ['tokens']),
    t('integrate', ['api', 'audit', 'email']),
  ];
  const graph = buildGraph(tasks, 'delivery', 'flow'),
    layout = layoutGraph(graph.nodes, graph.edges);
  assert.equal(graph.nodes.length, 6);
  assert.equal(graph.edges.length, 7);
  assert.deepEqual(layout.cyclic, []);
  for (const edge of graph.edges)
    assert.ok(layout.positions.get(edge.from).x + NODE_WIDTH < layout.positions.get(edge.to).x);
  const nodes = [...layout.positions.values()];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (nodes[i].layer === nodes[j].layer)
        assert.ok(Math.abs(nodes[i].y - nodes[j].y) >= NODE_HEIGHT);
  assert.deepEqual(
    layoutGraph([...graph.nodes].reverse(), [...graph.edges].reverse()).positions,
    layout.positions,
  );
});
test('composition has its own edges and reverses direction in the hierarchy view', () => {
  const tasks = [t('parent'), t('child-a', [], 'parent'), t('child-b', ['child-a'], 'parent')];
  const flow = buildGraph(tasks, 'delivery', 'flow');
  assert.ok(
    flow.edges.some((e) => e.from === 'child-b' && e.to === 'parent' && e.kind === 'hierarchy'),
  );
  assert.ok(
    flow.edges.some((e) => e.from === 'child-a' && e.to === 'child-b' && e.kind === 'dependency'),
  );
  const hierarchy = buildGraph(tasks, 'delivery', 'hierarchy');
  assert.ok(
    hierarchy.edges.some(
      (e) => e.from === 'parent' && e.to === 'child-a' && e.kind === 'hierarchy',
    ),
  );
  assert.ok(hierarchy.edges.some((e) => e.from === hierarchy.goalId && e.to === 'parent'));
  assert.ok(!hierarchy.edges.some((e) => e.kind === 'dependency'));
});
test('external prerequisites and disconnected work retain context without inventing execution order', () => {
  const graph = buildGraph([t('one', ['previous-delivery-card']), t('two')], 'd', 'flow');
  assert.equal(graph.nodes.filter((n) => n.id === 'previous-delivery-card')[0].kind, 'external');
  assert.ok(!graph.edges.some((e) => e.from === 'one' && e.to === 'two'));
  assert.equal(graph.edges.filter((e) => e.to === graph.goalId && e.kind === 'delivery').length, 2);
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, graph.nodes.length);
});
test('long dependency chains and malformed cyclic imports do not overflow the call stack', () => {
  const graph = buildGraph(
    Array.from({ length: 3000 }, (_, i) => t(String(i), i ? [String(i - 1)] : [])),
    'large',
    'flow',
  );
  const layout = layoutGraph(graph.nodes, graph.edges);
  assert.equal(layout.positions.size, 3000);
  assert.ok(Number.isFinite(layout.width));
  const cyclic = buildGraph([t('a', ['b']), t('b', ['a'])], 'd', 'flow');
  assert.deepEqual(layoutGraph(cyclic.nodes, cyclic.edges).cyclic.sort(), ['a', 'b']);
});
