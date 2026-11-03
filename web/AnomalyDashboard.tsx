import { usePermissions } from './permissions';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

type Severity = 'critical' | 'warning';
type Category = 'pairing' | 'location' | 'time';
type Range = '24h' | '7d' | 'month';
type Anomaly = {
  id: string;
  code: string;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  cdn: string | null;
  truck: string | null;
  equipmentId: number | null;
  loadingId: number | null;
  dumpingId: number | null;
  eventAt: string;
};
type Props = {
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  onOpenTransaction: (cdn: string) => void;
  onOpenTruckHistory: (target: { equipmentId: number; date: string; cdn: string | null; truck: string | null; eventAt: string }) => void;
};

// Rentang mengikuti jam browser; server memakai nilai yang sama apa adanya.
const rangeStart = (range: Range, now: number) => range === 'month'
  ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
  : now - ({ '24h': 24, '7d': 7 * 24 } as Record<'24h' | '7d', number>)[range] * 60 * 60 * 1000;
const sqlDate = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const severityOrder: Record<Severity, number> = { critical: 0, warning: 1 };
const severityLabel: Record<Severity, string> = { critical: 'Kritis', warning: 'Warning' };
const categoryLabel: Record<Category, string> = {
  pairing: 'Pasangan',
  location: 'Lokasi',
  time: 'Waktu',
};
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function formatEvent(value: string) {
  const [date, time = ''] = value.split('T');
  const [year, month, day] = date.split('-');
  const monthName = months[Number(month) - 1];
  return monthName ? `${Number(day)} ${monthName} ${year} · ${time.slice(0, 8)}` : value;
}

function formatDay(value: string) {
  const [, month, day] = value.split('-');
  return `${day}/${month}`;
}

function RouteDialog({ row, close, openTransaction, openTruckHistory }: {
  row: Anomaly;
  close: () => void;
  openTransaction: (cdn: string) => void;
  openTruckHistory: (target: { equipmentId: number; date: string; cdn: string | null; truck: string | null; eventAt: string }) => void;
}) {
  const can = usePermissions();
  const dialog = useRef<HTMLDialogElement>(null);
  const date = row.eventAt.slice(0, 10);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected && trigger.offsetParent !== null) trigger.focus();
    };
  }, []);
  return <dialog ref={dialog} className="anomaly-route-modal" aria-labelledby="anomaly-route-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="panel-heading">
      <div><span className="section-index">BUKA ANALISA</span><h2 id="anomaly-route-title">Pilih tujuan</h2></div>
      <button type="button" autoFocus onClick={close}>Tutup</button>
    </div>
    <div className="anomaly-route-body">
      <p className="anomaly-route-target">SK <strong className="mono">{row.cdn ?? '—'}</strong> · Truck <strong className="mono">{row.truck ?? '—'}</strong></p>
      <p className="helper">Analisa transaksi memakai SK; Timeline truck memakai truck, dengan rentang 3 jam sebelum dan 3 jam setelah waktu temuan. Tekan tombol muat pada halaman tujuan untuk menampilkan data.</p>
      <div className="anomaly-route-actions">
        <button type="button" hidden={!can('transactions.view')} className="primary anomaly-route-transaction" disabled={!row.cdn} onClick={() => {
          if (!row.cdn) return;
          close();
          openTransaction(row.cdn);
        }}>Analisa transaksi</button>
        <button type="button" hidden={!can('timeline.view')} className="anomaly-route-timeline" disabled={!row.equipmentId} onClick={() => {
          if (!row.equipmentId) return;
          close();
          openTruckHistory({ equipmentId: row.equipmentId, date, cdn: row.cdn, truck: row.truck, eventAt: row.eventAt });
        }}>Timeline truck</button>
      </div>
    </div>
  </dialog>;
}

export function AnomalyDashboard({ api, onOpenTransaction, onOpenTruckHistory }: Props) {
  const can = usePermissions();
  const hasRoutes = can('transactions.view') || can('timeline.view');
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<Range>('7d');
  const [truck, setTruck] = useState('');
  const [cdn, setCdn] = useState('');
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [category, setCategory] = useState<'all' | Category>('all');
  const [rows, setRows] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('—');
  const [routeRow, setRouteRow] = useState<Anomaly | null>(null);

  const start = rangeStart(range, now);
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ start: sqlDate(start), end: sqlDate(now) });
    if (truck.trim()) query.set('truck', truck.trim());
    if (cdn.trim()) query.set('cdn', cdn.trim());
    if (severity !== 'all') query.set('severity', severity);
    if (category !== 'all') query.set('category', category);
    setLoading(true);
    setError('');
    api<{ anomalies: Anomaly[] }>(`/anomalies?${query}`, 'GET', undefined, undefined)
      .then(({ anomalies }) => {
        if (cancelled) return;
        // id hanya untuk key React; SP tidak mengirim kolom id.
        setRows(anomalies.map((row, index) => ({ ...row, id: `${row.code}-${row.loadingId ?? row.dumpingId ?? index}-${row.eventAt}` })));
        setRefreshedAt(new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date()));
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Gagal memuat anomali.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, start, now, truck, cdn, severity, category]);

  const filtered = useMemo(() => rows
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.eventAt.localeCompare(a.eventAt)),
  [rows]);

  const stats = useMemo(() => ({
    critical: filtered.filter(row => row.severity === 'critical').length,
    warning: filtered.filter(row => row.severity === 'warning').length,
    sku: new Set(filtered.map(row => row.cdn).filter((value): value is string => Boolean(value))).size,
    truck: new Set(filtered.map(row => row.truck).filter((value): value is string => Boolean(value))).size,
  }), [filtered]);

  const trend = useMemo(() => {
    const groups = new Map<string, { day: string; critical: number; warning: number; total: number }>();
    for (let offset = 6; offset >= 0; offset--) {
      const day = new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      groups.set(day, { day, critical: 0, warning: 0, total: 0 });
    }
    filtered.forEach(row => {
      const day = row.eventAt.slice(0, 10);
      const current = groups.get(day);
      if (!current) return;
      current[row.severity] += 1;
      current.total += 1;
    });
    return [...groups.values()];
  }, [filtered]);
  const maxTrend = Math.max(1, ...trend.map(day => day.total));

  const topCodes = useMemo(() => {
    const groups = new Map<string, { code: string; severity: Severity; total: number }>();
    filtered.forEach(row => {
      const key = `${row.code}:${row.severity}`;
      const current = groups.get(key);
      if (current) current.total += 1;
      else groups.set(key, { code: row.code, severity: row.severity, total: 1 });
    });
    return [...groups.values()]
      .sort((a, b) => b.total - a.total || severityOrder[a.severity] - severityOrder[b.severity])
      .slice(0, 5);
  }, [filtered]);
  const maxCode = Math.max(1, ...topCodes.map(item => item.total));

  const topTrucks = useMemo(() => {
    const groups = new Map<string, { truck: string; total: number; critical: number }>();
    filtered.forEach(row => {
      if (!row.truck) return;
      const current = groups.get(row.truck);
      if (current) {
        current.total += 1;
        if (row.severity === 'critical') current.critical += 1;
      } else {
        groups.set(row.truck, { truck: row.truck, total: 1, critical: row.severity === 'critical' ? 1 : 0 });
      }
    });
    return [...groups.values()]
      .sort((a, b) => b.critical - a.critical || b.total - a.total)
      .slice(0, 5);
  }, [filtered]);
  const maxTruck = Math.max(1, ...topTrucks.map(item => item.total));

  function resetFilters() {
    setRange('7d');
    setTruck('');
    setCdn('');
    setSeverity('all');
    setCategory('all');
  }

  return <div className="anomaly-page">
    <div className="page-heading">
      <div>
        <h1 id="anomalies-title">Monitoring transaksi</h1>
      </div>
      <div className="heading-actions">
        <div className="anomaly-refresh-meta">
          <span className="muted">Diperbarui <strong className="mono">{refreshedAt}</strong></span>
        </div>
        <button type="button" className="icon-button" title="Refresh" aria-label="Refresh" onClick={() => setNow(Date.now())}><Icon name="reload" /></button>
      </div>
    </div>

    <section className="panel anomaly-filters" aria-label="Filter anomali">
      <div className="anomaly-filter-range">
        <span>Rentang</span>
        <div className="anomaly-range" role="group" aria-label="Rentang waktu">
          {(['24h', '7d', 'month'] as Range[]).map(value => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>
            {value === '24h' ? '24 jam' : value === '7d' ? '7 hari' : 'Bulan berjalan'}
          </button>)}
        </div>
      </div>
      <label>Truck<input type="search" value={truck} onChange={event => setTruck(event.target.value)} placeholder="Contoh: TR10040" autoComplete="off" /></label>
      <label>CoalDeliveryNumber<input type="search" value={cdn} onChange={event => setCdn(event.target.value)} placeholder="Contoh: AB260029085" autoComplete="off" /></label>
      <label>Severity<select value={severity} onChange={event => setSeverity(event.target.value as 'all' | Severity)}>
        <option value="all">Semua</option>
        <option value="critical">Kritis</option>
        <option value="warning">Warning</option>
      </select></label>
      <label>Kategori<select value={category} onChange={event => setCategory(event.target.value as 'all' | Category)}>
        <option value="all">Semua</option>
        <option value="pairing">Pasangan</option>
        <option value="location">Lokasi</option>
        <option value="time">Waktu</option>
      </select></label>
      <button type="button" className="anomaly-reset" title="Reset filter" aria-label="Reset filter" onClick={resetFilters}><Icon name="reset" /></button>
    </section>

    <section className="anomaly-kpis" aria-label="Ringkasan anomali">
      <article className="panel anomaly-kpi critical">
        <span>Kritis</span>
        <strong>{String(stats.critical).padStart(2, '0')}</strong>
        <small>Pasangan salah, data hilang, atau waktu terbalik</small>
      </article>
      <article className="panel anomaly-kpi warning">
        <span>Warning</span>
        <strong>{String(stats.warning).padStart(2, '0')}</strong>
        <small>Perlu verifikasi operator</small>
      </article>
      <article className="panel anomaly-kpi neutral">
        <span>Total temuan</span>
        <strong>{String(filtered.length).padStart(2, '0')}</strong>
        <small>Dalam filter aktif</small>
      </article>
      <article className="panel anomaly-kpi neutral">
        <span>SK terdampak</span>
        <strong>{String(stats.sku).padStart(2, '0')}</strong>
        <small>Dengan temuan</small>
      </article>
      <article className="panel anomaly-kpi neutral">
        <span>Truck terdampak</span>
        <strong>{String(stats.truck).padStart(2, '0')}</strong>
        <small>Dengan temuan</small>
      </article>
    </section>

    {loading ? (
    <section className="panel anomaly-skeleton" aria-label="Memuat data anomali" aria-busy="true">
      <div className="panel-heading">
        <div><h2 id="anomalies-title">Monitoring transaksi</h2></div>
      </div>
      <div className="anomaly-skeleton-body">
        <div className="skeleton-row">
          <div className="skeleton-block skeleton-wide"></div>
          <div className="skeleton-block skeleton-narrow"></div>
        </div>
        <div className="skeleton-row">
          <div className="skeleton-block skeleton-wide"></div>
          <div className="skeleton-block skeleton-narrow"></div>
          <div className="skeleton-block skeleton-narrow"></div>
        </div>
        <div className="skeleton-row">
          <div className="skeleton-block skeleton-wide"></div>
          <div className="skeleton-block skeleton-narrow"></div>
          <div className="skeleton-block skeleton-narrow"></div>
          <div className="skeleton-block skeleton-narrow"></div>
        </div>
        <div className="skeleton-row">
          <div className="skeleton-block skeleton-wide"></div>
          <div className="skeleton-block skeleton-narrow"></div>
          <div className="skeleton-block skeleton-narrow"></div>
        </div>
      </div>
    </section>
    ) : (
    <>
      <div className="anomaly-grid">
        <section className="panel anomaly-panel anomaly-trend" aria-labelledby="anomaly-trend-title">
          <div className="panel-heading">
            <div><span className="section-index">TREN</span><h2 id="anomaly-trend-title">Anomali per hari</h2></div>
            <span className="small-tag">7 HARI TERAKHIR</span>
          </div>
          <div className="anomaly-trend-body">
            {trend.length ? <div className="anomaly-bars" role="img" aria-label="Grafik anomali per hari">
              {trend.map(day => {
                const crit = Math.max(2, Math.round((day.critical / maxTrend) * 84));
                const warn = Math.max(2, Math.round((day.warning / maxTrend) * 84));
                return <div className="anomaly-bar-day" key={day.day} title={`${day.day}: ${day.total} temuan`}>
                  <div className="anomaly-bar-stack">
                    {day.critical > 0 && <span className="anomaly-bar critical" style={{ height: crit + 'px' }} />}
                    {day.warning > 0 && <span className="anomaly-bar warning" style={{ height: warn + 'px' }} />}
                  </div>
                  <small>{formatDay(day.day)}</small>
                </div>;
              })}
            </div> : <div className="anomaly-chart-empty"><span>00</span><p>Tidak ada temuan pada rentang ini.</p></div>}
            <div className="anomaly-legend">
              <span><i className="critical" /> Kritis</span>
              <span><i className="warning" /> Warning</span>
            </div>
          </div>
        </section>

        <section className="panel anomaly-panel" aria-labelledby="anomaly-codes-title">
          <div className="panel-heading">
            <div><span className="section-index">KODE</span><h2 id="anomaly-codes-title">Paling sering</h2></div>
            <span className="small-tag">TOP 5</span>
          </div>
          {topCodes.length ? <ul className="anomaly-code-list">
            {topCodes.map(item => <li key={`${item.code}-${item.severity}`}>
              <div className="anomaly-code-row">
                <span><strong>{item.code}</strong><small className={`anomaly-severity-text ${item.severity}`}>{severityLabel[item.severity]}</small></span>
                <strong>{item.total}</strong>
              </div>
              <div className="anomaly-code-bar"><span style={{ width: `${Math.round((item.total / maxCode) * 100)}%` }} /></div>
            </li>)}
          </ul> : <div className="empty compact"><h3>Tidak ada kode</h3><p>Ubah filter untuk melihat temuan lain.</p></div>}
        </section>
      </div>

      <div className="anomaly-grid anomaly-main-grid">
        <section className="panel anomaly-panel anomaly-table-panel" aria-labelledby="anomaly-table-title">
          <div className="panel-heading">
            <div><span className="section-index">DAFTAR TEMUAN</span><h2 id="anomaly-table-title">Anomali <span className="count">{filtered.length}</span></h2></div>
            <span className="helper" hidden={!hasRoutes}>Buka analisa untuk memeriksa bukti</span>
          </div>
          {filtered.length ? <div className="table-scroll">
            <table className="anomaly-table">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Anomali</th>
                  <th scope="col">SK</th>
                  <th scope="col">Truck</th>
                  <th scope="col">Waktu</th>
                  <th scope="col" hidden={!hasRoutes}><span className="sr-only">Aksi</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => <tr key={row.id} className={row.severity === 'critical' ? 'anomaly-row-critical' : undefined}>
                  <td><span className={`anomaly-severity ${row.severity}`}>{severityLabel[row.severity]}</span></td>
                  <td>
                    <strong>{row.title}</strong>
                    <span className="anomaly-code">{row.code} · {categoryLabel[row.category]} · K {row.loadingId ?? '—'} / T {row.dumpingId ?? '—'}</span>
                    <p className="anomaly-detail">{row.detail}</p>
                  </td>
                  <td><span className="mono">{row.cdn ?? '—'}</span></td>
                  <td><span className="mono">{row.truck ?? '—'}</span>{row.equipmentId !== null && <span className="anomaly-sub">#{row.equipmentId}</span>}</td>
                  <td><span className="anomaly-time">{formatEvent(row.eventAt)}</span></td>
                  <td hidden={!hasRoutes}><button type="button" className="anomaly-open" title="Buka analisa" aria-label="Buka analisa" hidden={!(can('transactions.view') && row.cdn) && !(can('timeline.view') && row.equipmentId)} onClick={() => setRouteRow(row)}><Icon name="open" /></button></td>
                </tr>)}
              </tbody>
            </table>
          </div> : <div className="empty compact">
            <span className="empty-number">00</span>
            <h3>Tidak ada anomali pada filter ini</h3>
            <p>Longgarkan rentang waktu atau hapus filter truck/SK.</p>
          </div>}
          <footer className="panel-footer">{filtered.length} temuan ditampilkan</footer>
        </section>

        <aside className="anomaly-side">
          <section className="panel anomaly-panel" aria-labelledby="anomaly-trucks-title">
            <div className="panel-heading">
              <div><span className="section-index">TRUCK</span><h2 id="anomaly-trucks-title">Paling terdampak</h2></div>
              <span className="small-tag">TOP 5</span>
            </div>
            {topTrucks.length ? <ul className="anomaly-truck-list">
              {topTrucks.map(item => <li key={item.truck}>
                <div className="anomaly-truck-row">
                  <span><strong className="mono">{item.truck}</strong><small>{item.critical} kritis · {item.total} temuan</small></span>
                  <strong>{item.total}</strong>
                </div>
                <div className="anomaly-code-bar"><span style={{ width: `${Math.round((item.total / maxTruck) * 100)}%` }} /></div>
              </li>)}
            </ul> : <div className="empty compact"><h3>Belum ada truck</h3><p>Filter saat ini tidak menyertakan truck.</p></div>}
          </section>

          <section className="panel anomaly-panel anomaly-help" aria-labelledby="anomaly-help-title">
            <div className="panel-heading">
              <div><span className="section-index">CARA BACA</span><h2 id="anomaly-help-title">Prioritas pemeriksaan</h2></div>
            </div>
            <div className="anomaly-help-body">
              <p><strong>Kritis</strong> — Kirim lebih dari 2 hari tanpa pasangan Terima, atau Kirim lebih dari 7 hari tanpa pasangan Terima.</p>
              <p><strong>Warning</strong> — LoadingLocation Kirim kosong, Kirim berpasangan ke Terima yang sudah dihapus, Kirim berpasangan ke Terima selanjutnya sehingga ada Terima sebelumnya yang belum berpasangan, SK kirim berpasangan SK terima yang dtEmpty ≤ dtLoaded SK kirim, atau CDN Kirim dan Terima berbeda.</p>
              <p className="helper">Dashboard hanya menunjukkan indikasi. Periksa bukti dan relasi di menu Analisa transaksi; tidak ada perubahan data otomatis.</p>
            </div>
          </section>
        </aside>
      </div>
    </>
  )}

  {routeRow && <RouteDialog row={routeRow} close={() => setRouteRow(null)} openTransaction={onOpenTransaction} openTruckHistory={onOpenTruckHistory} />}
</div>;
}
