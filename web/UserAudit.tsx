import { useEffect, useState, type FormEvent } from 'react';
import './user-audit.css';
import { Icon } from './Icon';
import { SkeletonPanel } from './SkeletonPanel';
import { auditActivity, auditOutcome, auditTarget, outcomes } from './audit-labels';

type Row = { id: string; actorUserId: number | null; username: string | null; displayName: string | null; action: string; target: string; operationId: string | null; outcome: string; createdAt: string };
type Result = { rows: Row[]; hasMore: boolean; offset: number; limit: number };
type Api = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export function UserAudit({ api }: { api: Api }) {
  const [filters, setFilters] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Result | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setData(null);
    api<Result>(`/auth/admin/audit?limit=50&offset=${offset}&${filters}`, 'GET', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Gagal memuat audit.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, offset, filters, refresh]);
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    new FormData(event.currentTarget).forEach((value, key) => { if (String(value).trim()) params.set(key, String(value).trim()); });
    setOffset(0); setFilters(params.toString()); setRefresh(value => value + 1);
  }
  return <section className="audit-page menu-page" aria-label="User Audit">
    <div className="page-heading"><h1>User Audit</h1><button type="button" className="icon-button" title="Muat ulang" aria-label="Muat ulang" aria-busy={busy} disabled={busy} onClick={() => setRefresh(value => value + 1)}><Icon name="reload" /></button></div>
    <form className="audit-filters" onSubmit={filter}>
      <label>Username<input name="user" maxLength={200} placeholder="Semua user" /></label>
      <label>Hasil<select name="outcome"><option value="">Semua hasil</option>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Mulai (UTC)<input name="start" type="datetime-local" step="1" /></label>
      <label>Akhir eksklusif (UTC)<input name="end" type="datetime-local" step="1" /></label>
      <button disabled={busy}>Terapkan</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="audit-table" tabIndex={0} role="region" aria-label="Daftar audit" aria-busy={busy}>
      {busy ? <SkeletonPanel title="Daftar audit" rows={6} /> : data && !data.rows.length ? <p role="status">Tidak ada audit untuk filter ini.</p> : data && <table>
        <thead><tr>{['User', 'Aktivitas', 'Target', 'Hasil', 'Waktu (lokal)'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.id}>
          <td>{row.displayName || '—'}<br /><span className="muted">{row.username || (row.actorUserId === null ? 'Sistem' : `User #${row.actorUserId}`)}</span></td>
          <td>{auditActivity(row.action, row.outcome)}<details className="audit-details"><summary>Detail aktivitas #{row.id}</summary>
            <dl><dt>Action / endpoint</dt><dd><code>{row.action}</code></dd><dt>Operation ID</dt><dd><code>{row.operationId || '—'}</code></dd><dt>Hasil asli</dt><dd>{row.outcome}</dd><dt>Target asli</dt><dd><pre>{row.target}</pre></dd></dl>
          </details></td>
          <td>{auditTarget(row.target, row.action)}</td>
          <td><span className="audit-outcome" data-outcome={row.outcome}>{auditOutcome(row.outcome)}</span></td>
          <td><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' })}</time></td>
        </tr>)}</tbody>
      </table>}
    </div>
    <div className="audit-pagination"><button disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Sebelumnya</button><span role="status">{data?.rows.length ? `${offset + 1}–${offset + data.rows.length}` : '0'} baris</span><button disabled={busy || !data?.hasMore} onClick={() => setOffset(value => value + 50)}>Berikutnya</button></div>
  </section>;
}
