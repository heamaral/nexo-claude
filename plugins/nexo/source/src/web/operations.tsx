import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldCheck, Clock3, GitBranch } from 'lucide-react';

export function RuntimeDiagnostics() {
  const [data, setData] = useState<any>(),
    [error, setError] = useState('');
  const refresh = async () => {
    try {
      const r = await fetch('/api/diagnostics');
      if (!r.ok) throw new Error('Diagnostics unavailable');
      setData(await r.json());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section className="operation-panel">
      <div className="operation-heading">
        <h3>
          <Activity />
          Runtime health
        </h3>
        <button
          className="icon-button"
          aria-label="Refresh diagnostics"
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>Reading coordinator...</p>
      ) : (
        <>
          <div className="info-grid">
            <div>
              <small>Runtime</small>
              <strong>{data.runtimeVersion}</strong>
            </div>
            <div>
              <small>Snapshot</small>
              <strong>{data.snapshot.status}</strong>
            </div>
            <div>
              <small>Lost contact</small>
              <strong>{data.staleAssignments.length}</strong>
            </div>
            <div>
              <small>History conflicts</small>
              <strong>{data.conflicts}</strong>
            </div>
          </div>
          <small>Canonical coordinator</small>
          <code className="break-path">{data.canonicalRoot}</code>
          {data.resources.length > 0 && (
            <>
              <h4>Resource availability</h4>
              <div className="operation-list">
                {data.resources.map((r: any) => (
                  <div key={r.id}>
                    <span>{r.id}</span>
                    <strong>
                      {r.owner
                        ? `Reserved by ${r.owner}`
                        : `${r.available} of ${r.capacity} available`}
                    </strong>
                  </div>
                ))}
              </div>
            </>
          )}
          {data.waiting.length > 0 && (
            <>
              <h4>Waiting for action</h4>
              <div className="operation-list">
                {data.waiting.slice(0, 30).map((t: any) => (
                  <div key={t.id}>
                    <span>
                      {t.id}
                      <small>{t.waiting.nextAction}</small>
                    </span>
                    <strong>
                      {t.waiting.owner}
                      <small>{Math.floor(t.ageSeconds / 60)} min</small>
                    </strong>
                  </div>
                ))}
              </div>
            </>
          )}
          {data.checks.length > 0 && (
            <>
              <h4>Verified gates</h4>
              <div className="operation-list">
                {data.checks.slice(0, 30).map((c: any) => (
                  <div key={c.taskId + c.checkId}>
                    <span>
                      {c.taskId} · {c.checkId}
                      <small>{c.reason}</small>
                    </span>
                    <strong className={c.status === 'PASS' ? 'success-text' : 'warning-text'}>
                      {c.status}
                    </strong>
                  </div>
                ))}
              </div>
            </>
          )}
          {data.workspaces.length > 0 && (
            <>
              <h4>Registered worktrees</h4>
              <div className="operation-list">
                {data.workspaces.map((w: any) => (
                  <div key={w.id}>
                    <span>
                      {w.id}
                      <small>
                        {w.branch} · {w.mode}
                      </small>
                    </span>
                    <strong>{w.missing ? 'Path missing' : 'Available'}</strong>
                  </div>
                ))}
              </div>
            </>
          )}
          <h4>Delivery acceptance</h4>
          <div className="operation-list">
            {data.acceptance.map((d: any) => (
              <div key={d.id}>
                <span>{d.id}</span>
                <strong>{d.ready ? 'Ready for acceptance' : `${d.pending} tasks remaining`}</strong>
              </div>
            ))}
          </div>
          <p className="notice">
            {data.telemetry.enabled
              ? `${data.telemetry.totals.samples} local usage samples, including ${data.telemetry.totals.estimates} estimates. Input ${data.telemetry.totals.input}, cache read ${data.telemetry.totals.cacheRead}, output ${data.telemetry.totals.output}.`
              : 'Usage telemetry is off. Enable it explicitly per project to record structured local measurements.'}
          </p>
        </>
      )}
    </section>
  );
}

export function ExecutionHistory({ taskId, revision }: { taskId: string; revision: number }) {
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const r = await fetch(`/api/executions?taskId=${encodeURIComponent(taskId)}`);
        if (!r.ok) throw new Error('Execution history unavailable');
        const value = await r.json();
        if (!stopped) {
          setItems(value.items);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [taskId, revision]);
  if (!items.length && !error) return null;
  return (
    <section className="operation-panel">
      <h3>
        <GitBranch />
        Execution attempts
      </h3>
      {error && <p role="alert">{error}</p>}
      <ol className="execution-timeline">
        {items.map((e) => (
          <li key={e.id}>
            <span className={'execution-dot ' + e.status} />
            <div>
              <strong>
                {e.status === 'completed' ? <ShieldCheck /> : <Clock3 />}
                {e.status.replaceAll('_', ' ')}
              </strong>
              <small>
                {e.model ?? 'Model not recorded'}
                {e.effort ? ` · ${e.effort} effort` : ''}
              </small>
              <code>{e.id}</code>
              {e.parentExecutionId && <small>Parent execution: {e.parentExecutionId}</small>}
              <small>
                {new Date(e.startedAt).toLocaleString()}
                {e.finishedAt ? ` to ${new Date(e.finishedAt).toLocaleTimeString()}` : ''}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
