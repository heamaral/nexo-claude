import './graph.css';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Box,
  CheckCheck,
  Clock3,
  Focus,
  GitBranch,
  Layers,
  Maximize2,
  Minus,
  OctagonX,
  Plus,
  Search,
  Target,
  Users,
} from 'lucide-react';
import {
  buildGraph,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphMode,
} from './graph-layout.js';

type Entity = { id: string; kind: string; data: any };
type Agent = { taskId: string; state: string };
type Camera = { x: number; y: number; scale: number };
const clamp = (value: number) => Math.max(0.06, Math.min(2, value));

export function DeliveryGraph({
  delivery,
  tasks,
  entities,
  agents,
  query,
  onOpen,
}: {
  delivery: Entity;
  tasks: Entity[];
  entities: Entity[];
  agents: Agent[];
  query: string;
  onOpen: (id: string) => void;
}) {
  const [mode, setMode] = useState<GraphMode>('flow');
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(
    null,
  );
  const fitted = useRef('');
  const arrowId = useId().replaceAll(':', '');
  const index = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const graph = useMemo(
    () => buildGraph(tasks as any, delivery.id, mode),
    [tasks, delivery.id, mode],
  );
  const layout = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph]);
  const workingIds = new Set(agents.filter((a) => a.state === 'working').map((a) => a.taskId));
  const childIds = new Map<string, string[]>();
  for (const t of tasks)
    if (t.data.parentId) {
      const children = childIds.get(t.data.parentId) ?? [];
      children.push(t.id);
      childIds.set(t.data.parentId, children);
    }
  const workingAncestors = new Set(workingIds);
  for (const id of workingIds) {
    const seen = new Set<string>();
    let parent = index.get(id)?.data.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      workingAncestors.add(parent);
      parent = index.get(parent)?.data.parentId;
    }
  }
  const working = (id: string) => workingAncestors.has(id);
  const phase = (entity?: Entity) =>
    index
      .get(entity?.data.deliveryId)
      ?.data.workflow.find((s: any) => s.id === entity?.data.stageId);
  const done = (id: string) => phase(index.get(id))?.phase === 'done';
  const needle = query.trim().toLowerCase();
  const matches = new Set(
    graph.nodes
      .filter(
        (n) =>
          n.kind !== 'delivery' &&
          (!needle ||
            (n.id + ' ' + index.get(n.id)?.data.title + ' ' + index.get(n.id)?.data.description)
              .toLowerCase()
              .includes(needle)),
      )
      .map((n) => n.id),
  );
  const related = new Set(hovered ? [hovered] : []);
  if (hovered)
    for (const edge of graph.edges)
      if (edge.from === hovered || edge.to === hovered) {
        related.add(edge.from);
        related.add(edge.to);
      }
  const fit = (ids?: Set<string>) => {
    const points = [...layout.positions].filter(([id]) => !ids || ids.has(id)).map(([, p]) => p);
    if (!points.length || !size.width) return;
    const left = Math.min(...points.map((p) => p.x)),
      top = Math.min(...points.map((p) => p.y));
    const width = Math.max(...points.map((p) => p.x)) + NODE_WIDTH - left;
    const height = Math.max(...points.map((p) => p.y)) + NODE_HEIGHT - top;
    const scale = Math.min(
      1,
      clamp(Math.min((size.width - 48) / width, (size.height - 60) / height)),
    );
    setCamera({
      scale,
      x: (size.width - width * scale) / 2 - left * scale,
      y: (size.height - height * scale) / 2 - top * scale,
    });
  };
  const zoom = (factor: number, x = size.width / 2, y = size.height / 2) =>
    setCamera((c) => {
      const scale = clamp(c.scale * factor),
        ratio = scale / c.scale;
      return { scale, x: x - (x - c.x) * ratio, y: y - (y - c.y) * ratio };
    });
  useEffect(() => {
    const node = viewport.current!;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const key = delivery.id + ':' + mode;
    if (size.width && fitted.current !== key) {
      fit();
      fitted.current = key;
    }
  }, [size, delivery.id, mode, layout]);
  useEffect(() => {
    const node = viewport.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.003), e.clientX - rect.left, e.clientY - rect.top);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [size]);
  const orbit = (active: boolean) =>
    active ? (
      <svg className="orbit" aria-hidden="true">
        <rect x="1" y="1" rx="13" />
      </svg>
    ) : null;
  const dependencies = tasks.reduce((count, task) => count + task.data.dependencies.length, 0);
  return (
    <section className="delivery-graph" aria-label="Mapa de tarefas da entrega">
      <div className="section-intro">
        <div>
          <h2>Do primeiro passo ao resultado</h2>
          <p>
            {mode === 'flow'
              ? 'Pré-requisitos à esquerda, próximos passos à direita. Clique para inspecionar.'
              : 'Da entrega às tarefas e subtarefas. A composição não define a ordem de execução.'}
          </p>
        </div>
        <span className="pill">
          <GitBranch />
          {dependencies} dependências · {tasks.length} cards
        </span>
      </div>
      <div className="graph-panel" ref={panel}>
        <div className="graph-toolbar">
          <div className="graph-modes" role="group" aria-label="Organização do mapa">
            <button aria-pressed={mode === 'flow'} onClick={() => setMode('flow')}>
              <GitBranch />
              Dependências
            </button>
            <button aria-pressed={mode === 'hierarchy'} onClick={() => setMode('hierarchy')}>
              <Layers />
              Hierarquia
            </button>
          </div>
          <div className="graph-controls">
            {needle && (
              <button
                className="button subtle"
                disabled={!matches.size}
                onClick={() => fit(matches)}
              >
                <Search />
                {matches.size} encontrados
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Diminuir zoom"
              onClick={() => zoom(1 / 1.2)}
            >
              <Minus />
            </button>
            <button
              className="graph-zoom"
              aria-live="polite"
              aria-label="Restaurar zoom 100%"
              title="Zoom 100%"
              onClick={() => zoom(1 / camera.scale)}
            >
              {Math.round(camera.scale * 100)}%
            </button>
            <button className="icon-button" aria-label="Aumentar zoom" onClick={() => zoom(1.2)}>
              <Plus />
            </button>
            <button className="icon-button" aria-label="Ajustar mapa à tela" onClick={() => fit()}>
              <Focus />
            </button>
            <button
              className="icon-button"
              aria-label="Alternar tela cheia do mapa"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
                else void panel.current?.requestFullscreen().catch(() => {});
              }}
            >
              <Maximize2 />
            </button>
          </div>
        </div>
        {!!layout.cyclic.length && (
          <p role="alert" className="graph-warning">
            Há relações cíclicas no histórico. Revise o plano no Claude antes de executar.
          </p>
        )}
        <div
          className={'graph-viewport' + (dragging ? ' dragging' : '')}
          ref={viewport}
          tabIndex={0}
          aria-label="Grafo interativo. Arraste para mover; use mais e menos para zoom e zero para ajustar."
          onKeyDown={(e) => {
            if (e.target !== viewport.current) return;
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              e.preventDefault();
              setCamera((c) => ({
                ...c,
                x: c.x + (e.key === 'ArrowLeft' ? 50 : e.key === 'ArrowRight' ? -50 : 0),
                y: c.y + (e.key === 'ArrowUp' ? 50 : e.key === 'ArrowDown' ? -50 : 0),
              }));
            } else if (e.key === '+' || e.key === '=') {
              e.preventDefault();
              zoom(1.2);
            } else if (e.key === '-') {
              e.preventDefault();
              zoom(1 / 1.2);
            } else if (e.key === '0') {
              e.preventDefault();
              fit();
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as Element).closest('button')) return;
            drag.current = {
              id: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              x: camera.x,
              y: camera.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d?.id === e.pointerId)
              setCamera((c) => ({
                ...c,
                x: d.x + e.clientX - d.startX,
                y: d.y + e.clientY - d.startY,
              }));
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onPointerUp={(e) => {
            if (drag.current?.id === e.pointerId) {
              drag.current = null;
              setDragging(false);
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          <div
            className="graph-world"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
            }}
          >
            <svg
              className="graph-edges"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={arrowId}
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path
                    d="M1,1 L6,3.5 L1,6"
                    fill="none"
                    stroke="context-stroke"
                    strokeWidth="1.2"
                  />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const from = layout.positions.get(edge.from)!,
                  to = layout.positions.get(edge.to)!;
                const x = from.x + NODE_WIDTH,
                  y = from.y + NODE_HEIGHT / 2,
                  tx = to.x - 2,
                  ty = to.y + NODE_HEIGHT / 2;
                let path = `M${x},${y}`,
                  cursorX = x,
                  cursorY = y;
                for (const via of layout.routes.get(edge.id) ?? []) {
                  const middleY = via.y + NODE_HEIGHT / 2,
                    bend = Math.max(28, (via.x - cursorX) / 2);
                  path += ` C${cursorX + bend},${cursorY} ${via.x - bend},${middleY} ${via.x},${middleY} L${via.x + NODE_WIDTH},${middleY}`;
                  cursorX = via.x + NODE_WIDTH;
                  cursorY = middleY;
                }
                const bend = Math.max(36, Math.abs(tx - cursorX) / 2);
                path += ` C${cursorX + bend},${cursorY} ${tx - bend},${ty} ${tx},${ty}`;
                const emphasized = hovered && (edge.from === hovered || edge.to === hovered);
                return (
                  <path
                    key={edge.id}
                    data-from={edge.from}
                    data-to={edge.to}
                    data-kind={edge.kind}
                    className={
                      'graph-edge ' +
                      edge.kind +
                      (done(edge.from) ? ' done' : '') +
                      (index.get(edge.to)?.data.blocker ? ' blocked' : '') +
                      (emphasized ? ' emphasized' : '') +
                      (hovered && !emphasized ? ' dimmed' : '')
                    }
                    markerEnd={`url(#${arrowId})`}
                    d={path}
                  >
                    <title>
                      {edge.kind === 'dependency' ? 'Depende de' : 'Contribui para'}:{' '}
                      {index.get(edge.from)?.data.title ?? edge.from} →{' '}
                      {index.get(edge.to)?.data.title ?? delivery.data.title}
                    </title>
                  </path>
                );
              })}
            </svg>
            {graph.nodes.map((node) => {
              const goal = node.kind === 'delivery',
                entity = goal ? delivery : index.get(node.id),
                position = layout.positions.get(node.id)!,
                active = goal ? false : working(node.id),
                completed = goal ? delivery.data.status === 'accepted' : done(node.id),
                blocked = !!entity?.data.blocker;
              const team = index.get(entity?.data.teamId);
              const count = agents.filter(
                (a) => a.state === 'working' && a.taskId === node.id,
              ).length;
              const label = goal
                ? 'Entrega final'
                : blocked
                  ? 'Bloqueado'
                  : active
                    ? 'Em execução'
                    : (phase(entity)?.name ?? 'Aguardando');
              return (
                <button
                  key={node.id}
                  data-node-id={node.id}
                  data-layer={position.layer}
                  data-parent-id={entity?.data.parentId}
                  className={
                    'graph-node card' +
                    (goal ? ' goal-node' : '') +
                    (node.kind === 'external' ? ' external-node' : '') +
                    (active ? ' working' : '') +
                    (completed ? ' completed' : '') +
                    (blocked ? ' is-blocked' : '') +
                    (needle && !matches.has(node.id) ? ' search-dimmed' : '') +
                    (needle && matches.has(node.id) ? ' search-match' : '') +
                    (hovered && !related.has(node.id) ? ' unrelated' : '')
                  }
                  style={{
                    left: position.x,
                    top: position.y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                  }}
                  onClick={() => onOpen(goal ? delivery.id : node.id)}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(node.id)}
                  onBlur={() => setHovered(null)}
                  aria-label={`${entity?.data.title ?? node.id}. ${completed ? 'Concluído' : label}. ${node.kind === 'external' ? 'Outra entrega.' : ''}`}
                  title={entity?.data.title ?? node.id}
                >
                  {orbit(active)}
                  <div className="graph-node-id">
                    {goal ? (
                      <Target />
                    ) : completed ? (
                      <CheckCheck />
                    ) : blocked ? (
                      <OctagonX />
                    ) : (
                      <Box />
                    )}
                    <span>{goal ? 'RESULTADO DA ENTREGA' : node.id}</span>
                    {node.kind === 'external' && <ArrowUpRight />}
                  </div>
                  <h3>{entity?.data.title ?? node.id}</h3>
                  <span
                    className={
                      'pill ' + (blocked ? 'blocked' : completed ? 'done' : active ? 'active' : '')
                    }
                  >
                    {blocked ? (
                      <OctagonX />
                    ) : completed ? (
                      <CheckCheck />
                    ) : active ? (
                      <Activity />
                    ) : (
                      <Clock3 />
                    )}
                    {completed ? 'Concluído' : label}
                  </span>
                  <div className="graph-node-context">
                    {goal ? (
                      <>
                        <Target />
                        {delivery.data.status === 'accepted'
                          ? 'Resultado preservado'
                          : 'Objetivo desta entrega'}
                      </>
                    ) : node.kind === 'external' ? (
                      <>
                        <ArrowUpRight />
                        Dependência de outra entrega
                      </>
                    ) : (
                      <>
                        <Users />
                        <span>
                          {team?.data.title ??
                            (childIds.has(node.id)
                              ? `${childIds.get(node.id)!.length} subtarefas`
                              : 'Tarefa da entrega')}
                        </span>
                        {count > 0 && <i className="live-dot" />}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {!tasks.length && (
            <p className="graph-empty">O planner ainda não registrou tarefas nesta entrega.</p>
          )}
        </div>
        <div className="graph-legend">
          {mode === 'flow' && (
            <span>
              <i className="legend-line dependency" />
              Dependência
            </span>
          )}
          <span>
            <i className="legend-line composition" />
            {mode === 'flow' ? 'Contribui para o resultado' : 'Composição: pai → filho'}
          </span>
          <span className="graph-gesture">Arraste para mover · Ctrl + rolagem para zoom</span>
        </div>
      </div>
    </section>
  );
}
