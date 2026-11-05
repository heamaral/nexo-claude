import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Layers,
  Columns3,
  Network,
  Route,
  Workflow,
  Sun,
  Moon,
  ArrowUpRight,
  ArrowLeft,
  ChevronRight,
  Check,
  CheckCheck,
  OctagonX,
  Clock3,
  Database,
  Zap,
  Search,
  X,
  GitBranch,
  Link as LinkIcon,
  ShieldCheck,
  Terminal,
  Activity,
  Command,
  RefreshCw,
  WifiOff,
  Target,
  Box,
  Users,
  ExternalLink,
} from 'lucide-react';
import './styles.css';
import { DeliveryGraph } from './delivery-graph.js';
type Entity = {
  kind: 'delivery' | 'team' | 'task';
  id: string;
  version: number;
  data: any;
  updatedAt: string;
};
type Agent = {
  agentId: string;
  taskId: string;
  name: string;
  role: string;
  teamId?: string;
  parentAgentId?: string;
  activity: string;
  state: string;
  expiresAt: number;
  fence: number;
  scopes: string[];
};
type State = {
  project: { name: string; id: string; maxAgents: number; maxTeamsPerDelivery: number };
  entities: Entity[];
  agents: Agent[];
  revision: number;
  eventCount: number;
  healthError?: string;
  snapshot?: { status: string; dirty: boolean; lastError: { code: string } | null };
  conflicts: any[];
};
type Detail = { type: 'entity' | 'flow' | 'policy'; id: string };
function App() {
  const [state, setState] = useState<State>(),
    [error, setError] = useState(''),
    [connection, setConnection] = useState('connecting'),
    [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState('board'),
    [all, setAll] = useState(false),
    [query, setQuery] = useState(''),
    [limit, setLimit] = useState(60),
    [history, setHistory] = useState<Detail[]>([]);
  const [theme, setTheme] = useState(() => {
    try {
      return (
        localStorage.getItem('nexo-theme') ??
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      );
    } catch {
      return 'dark';
    }
  });
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('nexo-theme', theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    let stopped = false,
      source: EventSource | undefined,
      busy = false,
      again = false;
    const refresh = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const response = await fetch('/api/state');
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'Open /board in Claude to authenticate this window.'
              : 'Could not read the project.',
          );
        const data = await response.json();
        if (!stopped) {
          setState(data);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(String((e as Error).message));
      } finally {
        busy = false;
        if (again && !stopped) {
          again = false;
          void refresh();
        }
      }
    };
    void (async () => {
      try {
        const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
        if (ticket) {
          window.history.replaceState(null, '', location.pathname);
          const r = await fetch('/api/bootstrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
          });
          if (!r.ok) throw new Error('Link expired. Run /board again in Claude.');
        }
        await refresh();
        if (stopped) return;
        source = new EventSource('/api/events');
        source.onopen = () => setConnection('online');
        source.addEventListener('change', () => void refresh());
        source.onerror = () => {
          setConnection('reconnecting');
        };
      } catch (e) {
        setError((e as Error).message);
        setConnection('offline');
      }
    })();
    return () => {
      stopped = true;
      source?.close();
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (history.length && !dialog.current?.open) dialog.current?.showModal();
    else if (!history.length && dialog.current?.open) {
      dialog.current.close();
      returnFocus.current?.focus();
    }
  }, [history.length]);
  const open = (d: Detail) => {
    if (!history.length) returnFocus.current = document.activeElement as HTMLElement;
    setHistory((h) => [...h, d]);
  };
  const entities = state?.entities ?? [],
    deliveries = entities.filter((e) => e.kind === 'delivery'),
    tasks = entities.filter((e) => e.kind === 'task'),
    teams = entities.filter((e) => e.kind === 'team'),
    agents = state?.agents ?? [],
    get = (id: string) => entities.find((e) => e.id === id),
    delivery = get(selected ?? '');
  const children = (id: string) => tasks.filter((t) => t.data.parentId === id);
  const stage = (t: Entity) =>
    get(t.data.deliveryId)?.data.workflow.find((s: any) => s.id === t.data.stageId);
  const done = (t: Entity) => stage(t)?.phase === 'done';
  const leaves = (items: Entity[]) =>
    items.filter((t) => !tasks.some((c) => c.data.parentId === t.id));
  const progress = (items: Entity[]) => {
    const leaf = leaves(items),
      completed = leaf.filter(done).length;
    return {
      completed,
      total: leaf.length,
      percent: leaf.length ? Math.round((completed / leaf.length) * 100) : 0,
    };
  };
  const active = (items: Entity[]) =>
    agents.filter((a) => a.state === 'working' && items.some((t) => t.id === a.taskId));
  const descend = (id: string): Entity[] => children(id).flatMap((c) => [c, ...descend(c.id)]);
  const filtered = (items: Entity[]) =>
    items.filter((t) =>
      (t.data.title + ' ' + t.id + ' ' + t.data.description)
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const choose = (id: string | null, global = false) => {
    setSelected(id);
    setAll(global);
    setQuery('');
    setLimit(60);
    setView('board');
  };
  const orbit = (working: boolean) =>
    working ? (
      <svg className="orbit" aria-hidden="true">
        <rect x="1" y="1" rx="13" />
      </svg>
    ) : null;
  const pill = (t: Entity) => {
    const a = active([t]);
    return (
      <span
        className={
          'pill ' + (t.data.blocker ? 'blocked' : done(t) ? 'done' : a.length ? 'active' : '')
        }
      >
        {t.data.blocker ? (
          <OctagonX />
        ) : done(t) ? (
          <CheckCheck />
        ) : a.length ? (
          <Activity />
        ) : (
          <Clock3 />
        )}
        {t.data.blocker ? 'Blocked' : a.length ? 'Running' : (stage(t)?.name ?? t.data.status)}
      </span>
    );
  };
  const track = (items: Entity[]) => {
    const p = progress(items);
    return (
      <div className="progress">
        <div>
          <strong>
            {p.percent}
            <small>%</small>
          </strong>
          <span>
            {p.completed} of {p.total} tasks
          </span>
        </div>
        <div
          className="track"
          role="progressbar"
          aria-valuenow={p.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Task progress"
        >
          <span style={{ width: p.percent + '%' }} />
        </div>
      </div>
    );
  };
  const card = (t: Entity) => {
    const sub = descend(t.id),
      a = active([t, ...sub]);
    return (
      <button
        key={t.id}
        className={'card task-card ' + (a.length ? 'working' : '')}
        onClick={() => open({ type: 'entity', id: t.id })}
      >
        {orbit(!!a.length)}
        <div className="card-top">
          <span className="mono">{t.id}</span>
          {pill(t)}
        </div>
        <h3>{t.data.title}</h3>
        {t.data.description && <p>{t.data.description.slice(0, 150)}</p>}
        {t.data.blocker && (
          <div className="blocker">
            <OctagonX />
            {t.data.blocker}
          </div>
        )}
        {sub.length > 0 && (
          <>
            <div className="steps">
              {leaves(sub).map((c) => (
                <span
                  key={c.id}
                  title={c.data.title}
                  className={done(c) ? 'done' : active([c]).length ? 'active' : ''}
                />
              ))}
            </div>
            <small>
              {progress(sub).completed}/{progress(sub).total} subtasks completed
            </small>
          </>
        )}
        <div className="task-foot">
          <span>
            {t.data.teamId ? (
              <>
                <Users />
                {get(t.data.teamId)?.data.title}
              </>
            ) : (
              <>
                <Box />
                {t.data.parentId ? 'Subtask' : 'Task'}
              </>
            )}
          </span>
          <span>
            {a.length ? (
              <>
                <i className="live-dot" />
                {a.length} {a.length === 1 ? 'agent' : 'agents'}
              </>
            ) : t.data.dependencies.length ? (
              <>
                <GitBranch />
                {t.data.dependencies.length}
              </>
            ) : null}
          </span>
        </div>
      </button>
    );
  };
  const detail = history.at(-1),
    entity = detail?.type === 'entity' ? get(detail.id) : undefined;
  const detailTask = entity?.kind === 'task' ? entity : undefined;
  const itemTasks =
    entity?.kind === 'delivery'
      ? tasks.filter((t) => t.data.deliveryId === entity.id)
      : entity?.kind === 'team'
        ? tasks.filter((t) => t.data.teamId === entity.id)
        : detailTask
          ? [detailTask, ...descend(detailTask.id)]
          : [];
  const selectedTasks = delivery ? tasks.filter((t) => t.data.deliveryId === delivery.id) : tasks;
  const shown = filtered(selectedTasks);
  function agentRow(a: Agent, depth = 0, seen = new Set<string>()): React.ReactNode {
    if (seen.has(a.agentId) || depth > 12) return null;
    const next = new Set(seen).add(a.agentId);
    return (
      <React.Fragment key={a.agentId}>
        <div className="agent-row" style={{ marginLeft: Math.min(depth, 4) * 16 }}>
          <div className={'avatar ' + (a.state === 'working' ? 'active' : '')}>
            <Terminal />
          </div>
          <div>
            <strong>{a.name}</strong>
            <p>{a.activity}</p>
            <button className="text-link" onClick={() => open({ type: 'entity', id: a.taskId })}>
              {get(a.taskId)?.data.title ?? a.taskId}
              <ArrowUpRight />
            </button>
          </div>
          <span className={'pill ' + (a.state === 'working' ? 'active' : 'warning')}>
            {a.state === 'working' ? 'Working' : 'Lost contact'}
          </span>
        </div>
        {agents
          .filter((c) => c.parentAgentId === a.agentId)
          .map((c) => agentRow(c, depth + 1, next))}
      </React.Fragment>
    );
  }
  const title = all ? 'All cards' : (delivery?.data.title ?? 'Deliveries');
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            choose(null);
          }}
        >
          <span>
            <Layers />
          </span>
          Nexo<small>LOCAL</small>
        </a>
        <div className="project-label">
          <span className="project-avatar">
            {state?.project.name.slice(0, 1).toUpperCase() ?? 'N'}
          </span>
          <div>
            <strong>{state?.project.name ?? 'Loading project'}</strong>
            <span>Project workspace</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <button className={!delivery && !all ? 'selected' : ''} onClick={() => choose(null)}>
            <Layers />
            Deliveries<span className="count">{deliveries.length}</span>
          </button>
          <button className={all ? 'selected' : ''} onClick={() => choose(null, true)}>
            <Columns3 />
            All cards<span className="count">{tasks.length}</span>
          </button>
          <div className="nav-label">PROJECT DELIVERIES</div>
          {deliveries.slice(0, 30).map((d) => (
            <button
              key={d.id}
              className={'delivery-nav ' + (selected === d.id ? 'selected' : '')}
              onClick={() => choose(d.id)}
            >
              <span
                className={
                  'dot ' +
                  (d.data.status === 'accepted'
                    ? 'done'
                    : active(tasks.filter((t) => t.data.deliveryId === d.id)).length
                      ? 'active'
                      : '')
                }
              />
              <span>{d.data.title}</span>
              {d.data.status === 'accepted' && <Check />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="policy" onClick={() => open({ type: 'policy', id: '' })}>
            <ShieldCheck />
            <span>
              Project coordination<small>Capacity and isolation</small>
            </span>
            <ChevronRight />
          </button>
          <div className="local-status">
            <Database />
            .nexo/ · Local and versioned
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <span>{state?.project.name ?? 'Project'}</span>
            <ChevronRight />
            {delivery ? (
              <button onClick={() => choose(null)}>Deliveries</button>
            ) : (
              <span>Workspace</span>
            )}
            {delivery && (
              <>
                <ChevronRight />
                <span>{delivery.data.title}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            <span className={'connection ' + connection}>
              {connection === 'online' ? <i className="live-dot" /> : <WifiOff />}
              {connection === 'online'
                ? 'Live'
                : connection === 'reconnecting'
                  ? 'Reconnecting'
                  : 'Connecting'}
            </span>
            <button
              className="icon-button"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>
        <div className="content">
          {(error || state?.healthError || !!state?.conflicts.length) && (
            <div className="error" role="alert">
              <OctagonX />
              <div>
                <strong>
                  {state?.conflicts.length
                    ? 'Project history conflict'
                    : state?.healthError
                      ? 'Synchronization needs attention'
                      : 'Connection unavailable'}
                </strong>
                <p>
                  {error ||
                    state?.healthError ||
                    `${state?.conflicts.length} divergent event(s). Run /nexo:doctor to review before continuing.`}
                </p>
              </div>
            </div>
          )}
          {state?.snapshot?.lastError && (
            <div className="snapshot-warning" role="status">
              <Database />
              <div>
                <strong>Snapshot awaiting publication</strong>
                <p>
                  Cards and agents remain saved in the local database. Nexo will retry publication
                  automatically. Before committing, run snapshot and wait for confirmation. Code:{' '}
                  {state.snapshot.lastError.code}.
                </p>
              </div>
            </div>
          )}
          <div className="heading">
            <div>
              <span className="eyebrow">
                {all ? 'PROJECT OVERVIEW' : delivery ? 'PROJECT DELIVERY' : 'FROM PLAN TO DELIVERY'}
              </span>
              <h1>{title}</h1>
              <p>
                {delivery?.data.description ??
                  (all
                    ? 'Every card keeps its context, dependencies and agents.'
                    : 'Every delivery has its own plan, teams and preserved result.')}
              </p>
            </div>
            {delivery && (
              <button className="button" onClick={() => open({ type: 'entity', id: delivery.id })}>
                <Target />
                Delivery status
                <ArrowUpRight />
              </button>
            )}
          </div>
          {delivery && (
            <>
              <div className="delivery-summary">
                <div>
                  <span
                    className={'pill ' + (delivery.data.status === 'accepted' ? 'done' : 'active')}
                  >
                    {delivery.data.status === 'accepted' ? <CheckCheck /> : <Target />}
                    {delivery.data.status === 'accepted'
                      ? 'Accepted delivery'
                      : delivery.data.status === 'active'
                        ? 'In progress'
                        : 'Planned'}
                  </span>
                  <div className="summary-stats">
                    <span>
                      <Box />
                      {leaves(selectedTasks).length} tasks
                    </span>
                    <span>
                      <Users />
                      {active(selectedTasks).length} agents working
                    </span>
                    <span>
                      <OctagonX />
                      {selectedTasks.filter((t) => t.data.blocker).length} blockers
                    </span>
                  </div>
                </div>
                {track(selectedTasks)}
              </div>
              <div className="toolbar">
                <div className="tabs" role="tablist" aria-label="Delivery views">
                  {[
                    ['board', 'Board', Columns3],
                    ['teams', 'Teams', Network],
                    ['path', 'Graph', Route],
                  ].map(([id, label, Icon]) => (
                    <button
                      key={String(id)}
                      role="tab"
                      aria-selected={view === id}
                      className={view === id ? 'selected' : ''}
                      onClick={() => {
                        setView(String(id));
                        setLimit(60);
                      }}
                    >
                      {React.createElement(Icon as typeof Columns3)}
                      {String(label)}
                    </button>
                  ))}
                </div>
                <button
                  className="button subtle"
                  onClick={() => open({ type: 'flow', id: delivery.id })}
                >
                  <Workflow />
                  View workflow
                </button>
              </div>
            </>
          )}
          {(delivery || all) && (
            <div className="filter-row">
              <div className="search">
                <Search />
                <input
                  ref={search}
                  placeholder="Search cards…"
                  aria-label="Search cards"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setLimit(60);
                  }}
                />
                <kbd>Ctrl K</kbd>
                {query && (
                  <button
                    className="icon-button"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    <X />
                  </button>
                )}
              </div>
              <span>
                {shown.length} cards{shown.length > limit ? ` · showing ${limit}` : ''}
              </span>
            </div>
          )}
          {!delivery && !all && (
            <>
              <div className="portfolio-stats">
                <span>
                  <span className="stat-icon">
                    <Target />
                  </span>
                  <strong>{deliveries.filter((d) => d.data.status !== 'accepted').length}</strong>
                  <small>open deliveries</small>
                </span>
                <span>
                  <span className="stat-icon">
                    <Activity />
                  </span>
                  <strong>{agents.filter((a) => a.state === 'working').length}</strong>
                  <small>agents working</small>
                </span>
                <span>
                  <span className="stat-icon done">
                    <CheckCheck />
                  </span>
                  <strong>{deliveries.filter((d) => d.data.status === 'accepted').length}</strong>
                  <small>accepted deliveries</small>
                </span>
              </div>
              {!deliveries.length ? (
                <div className="empty">
                  <Layers />
                  <h2>Your next step starts here.</h2>
                  <p>
                    Ask Claude to plan a delivery. It organizes the cards, dependencies and teams in
                    this project.
                  </p>
                  <code>/nexo:plan describe what you want to deliver</code>
                  <small>The board follows work in real time.</small>
                </div>
              ) : (
                <div className="portfolio">
                  {deliveries.slice(0, limit).map((d) => {
                    const items = tasks.filter((t) => t.data.deliveryId === d.id),
                      running = active(items);
                    return (
                      <article
                        className={'card delivery-card ' + (running.length ? 'working' : '')}
                        key={d.id}
                      >
                        {orbit(!!running.length)}
                        <button
                          className="delivery-open"
                          onClick={() => open({ type: 'entity', id: d.id })}
                        >
                          <div className="card-top">
                            <span className="delivery-icon">
                              <Target />
                            </span>
                            <span
                              className={
                                'pill ' +
                                (d.data.status === 'accepted'
                                  ? 'done'
                                  : running.length
                                    ? 'active'
                                    : '')
                              }
                            >
                              {d.data.status === 'accepted' ? (
                                <CheckCheck />
                              ) : running.length ? (
                                <Activity />
                              ) : (
                                <Clock3 />
                              )}
                              {d.data.status === 'accepted'
                                ? 'Accepted'
                                : running.length
                                  ? 'Running'
                                  : 'Planned'}
                            </span>
                          </div>
                          <h2>{d.data.title}</h2>
                          <p>{d.data.description || 'Scope organized by the project planner.'}</p>
                        </button>
                        {track(items)}
                        <div className="delivery-meta">
                          <span>
                            <Users />
                            {running.length} agents
                          </span>
                          <span>
                            <Network />
                            {teams.filter((t) => t.data.deliveryId === d.id).length} teams
                          </span>
                        </div>
                        <button className="button primary" onClick={() => choose(d.id)}>
                          Open delivery
                          <ArrowUpRight />
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {(all || (delivery && view === 'board')) &&
            (all ? (
              <div className="all-cards">{shown.slice(0, limit).map(card)}</div>
            ) : (
              <div className="board">
                {delivery!.data.workflow.map((s: any) => (
                  <section className="column" key={s.id}>
                    <div className="column-head">
                      <span className={'dot ' + s.phase} />
                      <h2>{s.name}</h2>
                      {s.gate && <ShieldCheck />}
                      <span className="count">
                        {shown.filter((t) => t.data.stageId === s.id).length}
                      </span>
                    </div>
                    <div className="column-cards">
                      {shown
                        .filter((t) => t.data.stageId === s.id)
                        .slice(0, limit)
                        .map(card)}
                      {!shown.some((t) => t.data.stageId === s.id) && (
                        <div className="column-empty">No cards in this stage</div>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            ))}
          {delivery && view === 'teams' && (
            <>
              <div className="section-intro">
                <div>
                  <h2>Teams moving this delivery forward</h2>
                  <p>Clear scopes, parallel execution and integration at the end.</p>
                </div>
                <span className="pill">
                  <ShieldCheck />
                  Up to {state?.project.maxTeamsPerDelivery} concurrent teams
                </span>
              </div>
              <div className="teams-grid">
                {teams
                  .filter((t) => t.data.deliveryId === delivery.id)
                  .map((team) => {
                    const ta = agents.filter((a) => a.teamId === team.id),
                      working = ta.filter((a) => a.state === 'working');
                    return (
                      <article
                        className={'card team-card ' + (working.length ? 'working' : '')}
                        key={team.id}
                      >
                        {orbit(!!working.length)}
                        <button
                          className="delivery-open"
                          onClick={() => open({ type: 'entity', id: team.id })}
                        >
                          <div className="card-top">
                            <span className="delivery-icon">
                              <Network />
                            </span>
                            <span className={'pill ' + (working.length ? 'active' : '')}>
                              {working.length ? <Activity /> : <Clock3 />}
                              {working.length ? 'Running' : 'Waiting'}
                            </span>
                          </div>
                          <h2>{team.data.title}</h2>
                          <p>{team.data.description || team.data.engine}</p>
                        </button>
                        <div className="team-agents">
                          {ta
                            .filter(
                              (a) =>
                                !a.parentAgentId || !ta.some((p) => p.agentId === a.parentAgentId),
                            )
                            .map((a) => agentRow(a))}
                          {!ta.length && <p className="muted">No active agents on this team.</p>}
                        </div>
                        <button
                          className="text-link"
                          onClick={() => open({ type: 'entity', id: team.id })}
                        >
                          View scope and tasks
                          <ArrowUpRight />
                        </button>
                      </article>
                    );
                  })}
              </div>
              {agents
                .filter((a) => selectedTasks.some((t) => t.id === a.taskId) && !a.teamId)
                .map((a) => agentRow(a))}
              {!teams.some((t) => t.data.deliveryId === delivery.id) && (
                <div className="empty small">
                  <Network />
                  <h2>One plan, multiple paths forward.</h2>
                  <p>
                    The planner creates teams for independent tasks. Agents appear here when they
                    claim a card.
                  </p>
                </div>
              )}
            </>
          )}
          {delivery && view === 'path' && (
            <DeliveryGraph
              delivery={delivery}
              tasks={selectedTasks}
              entities={entities}
              agents={agents}
              query={query}
              onOpen={(id) => open({ type: 'entity', id })}
            />
          )}
          {(((all || (delivery && view === 'board')) && shown.length > limit) ||
            (deliveries.length > limit && !delivery && !all)) && (
            <button className="button load-more" onClick={() => setLimit((n) => n + 60)}>
              Load more
            </button>
          )}
          <footer>
            <span>
              <Database />
              {state?.eventCount ?? 0} persisted events · SQLite + history
            </span>
            <span>
              <ShieldCheck />
              Accepted deliveries preserve their history
            </span>
          </footer>
        </div>
      </main>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          setHistory([]);
        }}
        onClick={(e) => {
          if (e.target === dialog.current) {
            const r = dialog.current.getBoundingClientRect();
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              setHistory([]);
          }
        }}
        aria-labelledby="detail-title"
      >
        <div className="modal-head">
          {history.length > 1 && (
            <button
              className="icon-button"
              aria-label="Back to previous details"
              onClick={() => setHistory((h) => h.slice(0, -1))}
            >
              <ArrowLeft />
            </button>
          )}
          <span>
            {detail?.type === 'flow'
              ? 'DELIVERY WORKFLOW'
              : detail?.type === 'policy'
                ? 'PROJECT COORDINATION'
                : entity?.kind === 'delivery'
                  ? 'DELIVERY'
                  : entity?.kind === 'team'
                    ? 'TEAM'
                    : 'CARD'}
          </span>
          <button className="icon-button" aria-label="Close details" onClick={() => setHistory([])}>
            <X />
          </button>
        </div>
        <div className="modal-content">
          <h2 id="detail-title">
            {detail?.type === 'flow'
              ? 'A workflow that fits the project'
              : detail?.type === 'policy'
                ? 'Parallel work with context'
                : (entity?.data.title ?? 'Details unavailable')}
          </h2>
          {detail?.type === 'policy' ? (
            <>
              <p>These limits belong to this project and include all agents registered in Nexo.</p>
              <div className="info-grid">
                <div>
                  <small>Concurrent agents</small>
                  <strong>{state?.project.maxAgents}</strong>
                </div>
                <div>
                  <small>Teams per delivery</small>
                  <strong>{state?.project.maxTeamsPerDelivery}</strong>
                </div>
              </div>
              <h3>How work is coordinated</h3>
              <ul>
                <li>One executor per card, with explicit collaborators and reviewers.</li>
                <li>Overlapping write scopes wait until released.</li>
                <li>Expired leases appear as “lost contact”; this does not complete the card.</li>
                <li>Independent teams use separate sessions and worktrees.</li>
                <li>Native Agent Teams are optional and subject to Claude limitations.</li>
              </ul>
              <p className="notice">
                Ask Claude to adapt stages, gates and capacity to the project. The board displays
                persisted state.
              </p>
            </>
          ) : detail?.type === 'flow' ? (
            <>
              <p>
                Stages and gates belong to this delivery. The planner can adapt the workflow while
                it is open.
              </p>
              <div className="flow-list">
                {get(detail.id)?.data.workflow.map((s: any, i: number) => (
                  <div key={s.id}>
                    <span className="flow-number">{i + 1}</span>
                    <div>
                      <h3>{s.name}</h3>
                      <p>
                        {s.gate ??
                          (s.phase === 'done'
                            ? 'Result and evidence recorded.'
                            : 'Stage: ' + s.phase)}
                      </p>
                    </div>
                    {s.gate ? <ShieldCheck /> : <ChevronRight />}
                  </div>
                ))}
              </div>
              <p className="notice">
                Claude makes workflow changes and records them in history. Accepted deliveries
                retain their original workflow.
              </p>
            </>
          ) : (
            entity && (
              <>
                <div className="detail-meta">
                  <span className="mono">
                    {entity.id} · v{entity.version}
                  </span>
                  {detailTask ? (
                    pill(detailTask)
                  ) : (
                    <span className="pill">{entity.data.status ?? entity.data.engine}</span>
                  )}
                </div>
                {entity.data.description && (
                  <p className="description">{entity.data.description}</p>
                )}
                {entity.data.blocker && (
                  <div className="blocker">
                    <OctagonX />
                    {entity.data.blocker}
                  </div>
                )}
                {itemTasks.length > 0 && track(itemTasks)}
                {entity.kind === 'task' && (
                  <>
                    <h3>Acceptance criteria</h3>
                    {entity.data.criteria.length ? (
                      <ul className="criteria">
                        {entity.data.criteria.map((c: string, i: number) => (
                          <li key={i}>
                            {done(entity) ? <Check /> : <span className="check-empty" />}
                            {c}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">The planner has not recorded criteria yet.</p>
                    )}
                    {children(entity.id).length > 0 && (
                      <>
                        <h3>Subtasks</h3>
                        <div className="related-list">
                          {children(entity.id).map((t) => (
                            <button key={t.id} onClick={() => open({ type: 'entity', id: t.id })}>
                              {done(t) ? <CheckCheck /> : <Box />}
                              <span>{t.data.title}</span>
                              {pill(t)}
                              <ChevronRight />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {entity.data.dependencies.length > 0 && (
                      <>
                        <h3>Depends on</h3>
                        <div className="related-list">
                          {entity.data.dependencies.map((id: string) => (
                            <button key={id} onClick={() => open({ type: 'entity', id })}>
                              {get(id) && done(get(id)!) ? <CheckCheck /> : <GitBranch />}
                              <span>{get(id)?.data.title ?? id}</span>
                              <ChevronRight />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
                {entity.kind === 'team' && (
                  <div className="info-grid">
                    <div>
                      <small>Execution engine</small>
                      <strong>{entity.data.engine}</strong>
                    </div>
                    <div>
                      <small>Capacity</small>
                      <strong>{entity.data.maxAgents} agents</strong>
                    </div>
                    <div>
                      <small>Workspace</small>
                      <code>{entity.data.workspace || 'Not specified'}</code>
                    </div>
                  </div>
                )}
                {entity.data.result && (
                  <>
                    <h3>Recorded result</h3>
                    <p className="result">{entity.data.result}</p>
                  </>
                )}
                {entity.data.evidence?.length > 0 && (
                  <>
                    <h3>Evidence</h3>
                    {entity.data.evidence.map((e: any, i: number) => (
                      <div className="evidence" key={i}>
                        <ShieldCheck />
                        <div>
                          <strong>{e.label}</strong>
                          {e.commit && <code>{e.commit}</code>}
                          {e.url && /^https?:\/\//.test(e.url) && (
                            <a href={e.url} target="_blank" rel="noreferrer">
                              Open evidence
                              <ExternalLink />
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {entity.kind !== 'task' && itemTasks.length > 0 && (
                  <>
                    <h3>Cards in this {entity.kind === 'delivery' ? 'delivery' : 'team'}</h3>
                    <div className="related-list">
                      {itemTasks.slice(0, 60).map((t) => (
                        <button key={t.id} onClick={() => open({ type: 'entity', id: t.id })}>
                          <Box />
                          <span>{t.data.title}</span>
                          {pill(t)}
                          <ChevronRight />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {agents.some((a) => itemTasks.some((t) => t.id === a.taskId)) && (
                  <>
                    <h3>Assigned agents</h3>
                    {agents
                      .filter((a) => itemTasks.some((t) => t.id === a.taskId))
                      .map((a) => agentRow(a))}
                  </>
                )}
                {entity.kind === 'delivery' && (
                  <div className="modal-actions">
                    <button
                      className="button primary"
                      onClick={() => {
                        choose(entity.id);
                        setHistory([]);
                      }}
                    >
                      Open delivery
                      <ArrowUpRight />
                    </button>
                    <button
                      className="button"
                      onClick={() => open({ type: 'flow', id: entity.id })}
                    >
                      <Workflow />
                      View workflow
                    </button>
                  </div>
                )}
                <div className="detail-bottom">
                  <Clock3 />
                  Updated {new Date(entity.updatedAt).toLocaleString('en-US')}
                </div>
              </>
            )
          )}
        </div>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
