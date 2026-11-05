import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Combobox } from './Combobox';
import { DateField, TimeField } from './DateTimeField';
import { Icon } from './Icon';
import { ActionIcon, Details } from './TransactionCard';
import { RelationModal } from './Transactions';
import { SkeletonPanel } from './SkeletonPanel';
import { groupTruckActivities, groupTruckTransactions, transactionKind, type Row } from './transaction-analysis';
import { TruckActivities } from './TruckActivities';

type Props = {
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  initialTarget?: { equipmentId: number; date: string; cdn: string | null; truck: string | null; eventAt: string } | null;
};
type Result = { equipmentId: number; starttime: string; endtime: string; transactions: Row[]; activities: Row[] };
const text = (value: Row[string] | undefined) => value == null || value === '' ? '—' : String(value);
const time = (value: Row[string] | undefined) => text(value).replace('T', ' ').replace(/Z$/, '');
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
// Waktu temuan tanpa zona; geser manual ±jam lalu format lokal, tanpa Date ISO bermutu (jam tetap jam database).
const shift = (iso: string, hours: number) => {
  const at = new Date(iso);
  at.setTime(at.getTime() + hours * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};
const windowAround = (eventAt: string | undefined, date: string) => ({ start: eventAt ? shift(eventAt, -3) : `${date}T00:00:00`, end: eventAt ? shift(eventAt, 5) : `${date}T23:59:59` });
export function TruckHistory({ api, initialTarget = null }: Props) {
  const [equipment, setEquipment] = useState<{ EquipmentID: number; strTruckCN: string }[]>([]);
  const [equipmentError, setEquipmentError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<typeof equipment>('/equipments?activeOnly=true', 'GET', undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setEquipment(rows); })
      .catch(cause => { if (!controller.signal.aborted) setEquipmentError(cause instanceof Error ? cause.message : 'Daftar truck gagal dimuat.'); });
    return () => controller.abort();
  }, [api]);
  const label = (target: NonNullable<Props['initialTarget']>) => target.truck ? `${target.truck} · #${target.equipmentId}` : String(target.equipmentId);
  const [truck, setTruck] = useState(() => initialTarget ? label(initialTarget) : '');
  const [start, setStart] = useState(() => windowAround(initialTarget?.eventAt, initialTarget?.date ?? today()).start);
  const [end, setEnd] = useState(() => windowAround(initialTarget?.eventAt, initialTarget?.date ?? today()).end);
  const [result, setResult] = useState<Result | null>(null);
  const [tab, setTab] = useState<'transactions' | 'activities'>('transactions');
  const [page, setPage] = useState(0);
  const [relationRow, setRelationRow] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const workspace = useRef<HTMLDivElement | null>(null);
  // Kembali ke atas saat pindah halaman/tab; panggil langsung di onClick agar tidak tertunda render.
  const scrollToTop = () => {
    window.scrollTo(0, 0);
    const root = workspace.current;
    if (!root) return;
    root.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    root.querySelectorAll('.truck-trips, .transaction-results, .transaction-timeline').forEach(node => {
      node.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
  };
  useEffect(() => () => pending.current?.abort(), []);
  // Kembali ke atas saat pindah halaman/tab; gulir bisa di window, workspace, atau panel ritase.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    const root = workspace.current;
    if (!root) return;
    root.scrollTop = 0;
    root.querySelectorAll('.truck-trips').forEach(node => { node.scrollTop = 0; });
  }, [page, tab]);
  const matches = equipment.filter(row => truck.trim() === `${row.strTruckCN} · #${row.EquipmentID}` || truck.trim().toLowerCase() === row.strTruckCN?.trim().toLowerCase());
  const labelId = truck.trim().match(/#(\d+)$/)?.[1];
  const equipmentId = matches.length === 1 ? matches[0].EquipmentID : /^\d+$/.test(truck.trim()) ? Number(truck.trim()) : labelId ? Number(labelId) : 0;
  const search = useCallback(async (equipmentId: number, start: string, end: string) => {
    if (pending.current) return;
    setError('');
    setResult(null);
    if (!Number.isSafeInteger(equipmentId) || equipmentId <= 0 || equipmentId > 2147483647) { setError('Pilih truck yang unik atau masukkan EquipmentID positif.'); return; }
    const validTime = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
    if (!validTime.test(start) || !validTime.test(end) || end < start) { setError('Waktu selesai tidak boleh sebelum waktu mulai.'); return; }
    const controller = new AbortController();
    pending.current = controller;
    setHistoryLoading(true);
    setBusy(true);
    try {
      const query = new URLSearchParams({ equipmentId: String(equipmentId), starttime: start, endtime: end });
      const data = await api<Result>(`/transactions/truck-history?${query}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) { setResult(data); setTab('transactions'); setPage(0); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Timeline truck gagal dimuat.');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
        setHistoryLoading(false);
      }
    }
  }, [api]);
  const consumedTarget = useRef<Props['initialTarget']>(null);
  useEffect(() => {
    if (!initialTarget || consumedTarget.current === initialTarget) return;
    consumedTarget.current = initialTarget;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setHistoryLoading(false);
    const window = windowAround(initialTarget.eventAt, initialTarget.date);
    setTruck(label(initialTarget));
    setStart(window.start);
    setEnd(window.end);
    setRelationRow(null);
    setTab('transactions');
    setPage(0);
    void search(initialTarget.equipmentId, window.start, window.end);
  }, [initialTarget, search]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void search(equipmentId, start, end);
  }
  const transactions = result?.transactions.filter(row => transactionKind(row) !== 'TerimaRaw') ?? [];
  const rows = tab === 'transactions' ? transactions : result?.activities ?? [];
  const groups = useMemo(() => groupTruckActivities(result?.activities ?? []), [result]);
  const transactionGroups = useMemo(() => groupTruckTransactions(result?.transactions.filter(row => transactionKind(row) !== 'TerimaRaw') ?? []), [result]);
  // ponytail: pagination lokal; pindahkan ke procedure jika payload besar. Ritase tidak dipecah antarhalaman.
  const pageSize = 10;
  const total = tab === 'activities' ? groups.length : transactionGroups.length;
  const offset = page * pageSize;
  const renderRows = (items: Row[]) => <ol className="transaction-timeline" tabIndex={0} aria-label="Urutan riwayat truck">
    {items.map((row, index) => <li key={index} className={row.dtDeletedAt != null ? 'deleted-record' : ''}>
      <span className="timeline-marker">{String(index + 1).padStart(2, '0')}</span>
      <article>
        <div className="transaction-title"><h3>{transactionKind(row)}</h3></div>
        <div className="transaction-meta"><span>SK {text(row.CoalDeliveryNumber)}</span><span className="mono">ID {text(row.CTFinalTonnageID)}</span>{['Kirim', 'Terima'].includes(transactionKind(row)) && <button type="button" className="transaction-icon-button" title="Cek relasi" onClick={() => setRelationRow(row)} aria-label={`Cek relasi ${transactionKind(row)} ${text(row.CTFinalTonnageID)}`}><ActionIcon action="inspect" /></button>}{transactionKind(row) === 'Kirim' && <span>RefRelasi: <strong>{text(row.RefDumpingTonnageID)}</strong></span>}</div>
        <Details row={row} />
        <div className="transaction-times"><span>Timbang kosong <time>{time(row.dtEmpty)}</time></span><span>Timbang muat <time>{time(row.dtLoaded)}</time></span></div>
        {row.dtDeletedAt != null && <span className="deleted-status">Sudah dihapus · {time(row.dtDeletedAt)}</span>}
      </article>
    </li>)}
  </ol>;
  return <>
    <div className="transaction-workspace truck-history" ref={workspace}>
    <div className="page-heading">
      <h1 id="truck-history-title">Timeline truck</h1>
    </div>
    <form className="truck-history-search" onSubmit={submit}>
      <label htmlFor="history-truck">Truck / Equipment
        <Combobox id="history-truck" value={truck} onChange={setTruck} options={equipment.map(row => `${row.strTruckCN} · #${row.EquipmentID}`)} placeholder={equipment.length ? 'Pilih truck atau ketik EquipmentID' : 'Ketik EquipmentID'} disabled={busy} required describedBy="history-time-help" />
      </label>
      {([{ id: 'history-start', label: 'Mulai', value: start, set: setStart }, { id: 'history-end', label: 'Selesai', value: end, set: setEnd }]).map(field => <div className="history-datetime" key={field.id}>
        <DateField id={field.id} label={`Tanggal ${field.label.toLowerCase()}`} value={field.value} onChange={field.set} disabled={busy} describedBy="history-time-help" />
        <TimeField id={`${field.id}-time`} label={`Jam ${field.label.toLowerCase()} (24 jam)`} value={field.value} onChange={field.set} disabled={busy} describedBy="history-time-help" />
      </div>)}
      <button className="primary transaction-icon-button" title="Tampilkan timeline" aria-label="Tampilkan timeline" aria-busy={busy} disabled={busy}><Icon name="search" /></button>
    </form>
    <p className="helper" id="history-time-help">Waktu mengikuti jam database, tanpa konversi zona waktu. Pilih tanggal dan jam dengan picker. Batas mulai dan selesai termasuk hasil.</p>
    {initialTarget && <p className="helper anomaly-target-note" role="status">Dari Monitoring transaksi: SK <strong className="mono">{initialTarget.cdn ?? '—'}</strong> · {initialTarget.date}. Rentang 3 jam sebelum dan 5 jam setelah waktu temuan dimuat otomatis.</p>}
    {equipmentError && <p className="error" role="alert">Daftar truck gagal dimuat. Masukkan EquipmentID manual. {equipmentError}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status" aria-busy="true">Memuat riwayat truck…</p>}
    {historyLoading && <SkeletonPanel title="Timeline truck" subtitle="Pilih truck dan rentang waktu untuk melihat riwayat transaksi serta aktivitas reader." rows={4} />}
    {!historyLoading && result && <>
      <div className="transaction-summary" role="status">
        <div><span>Truck</span><strong>{equipment.find(row => row.EquipmentID === result.equipmentId)?.strTruckCN || '—'} #{result.equipmentId}</strong></div>
        <div><span>Mulai</span><strong>{time(result.starttime)}</strong></div>
        <div><span>Selesai</span><strong>{time(result.endtime)}</strong></div>
      </div>
      <div className="view-tabs" role="group" aria-label="Jenis riwayat">
        <button type="button" aria-pressed={tab === 'transactions'} onClick={() => { setTab('transactions'); setPage(0); scrollToTop(); }}>Kirim / Terima <span className="count">{transactions.length}</span></button>
        <button type="button" aria-pressed={tab === 'activities'} onClick={() => { setTab('activities'); setPage(0); scrollToTop(); }}>Aktivitas truck <span className="count">{result.activities.length}</span></button>
      </div>
      <section className="panel transaction-results" aria-label="Hasil timeline truck">
        <div className="panel-heading"><h2>{tab === 'transactions' ? 'Kirim / Terima' : 'Aktivitas truck'}</h2><span className="helper">Urutan hasil procedure · {rows.length} baris</span></div>
        {!rows.length ? <p className="history-empty" role="status">Tidak ada {tab === 'transactions' ? 'transaksi Kirim / Terima' : 'aktivitas'} dalam rentang ini.</p> : tab === 'activities' ? <TruckActivities key={page} groups={groups.slice(offset, offset + pageSize)} offset={offset} /> : <div className="truck-trips" key={page} tabIndex={0} role="region" aria-label="Ritase transaksi truck">
          <p className="helper">Kelompok berdasarkan RefDumpingTonnageID, bukan SK saja. Pasangan hanya mencakup hasil dalam rentang pencarian.</p>
          {transactionGroups.slice(offset, offset + pageSize).map((group, index) => <section className="truck-trip" key={index} aria-label={`Ritase ${offset + index + 1}`}>
            <header className="trip-heading"><div><h3>Ritase {offset + index + 1} · SK {group.sk.join(', ') || 'belum tercatat'}</h3><p>Mulai {time(group.start)} · Selesai {time(group.end)}</p></div><span className={`status ${group.status === 'Terhubung' ? 'online' : 'unknown'}`}>{group.status}</span></header>
            {!!group.notes.length && <ul className="trip-notes">{group.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
            {renderRows(group.rows)}
          </section>)}
        </div>}
        {total > pageSize && <div className="history-pagination" role="group" aria-label="Halaman riwayat">
          <button type="button" disabled={page === 0} onClick={() => { setPage(page - 1); scrollToTop(); }}>Sebelumnya</button>
          <span role="status">{offset + 1}–{Math.min(offset + pageSize, total)} / {total} ritase</span>
          <button type="button" disabled={offset + pageSize >= total} onClick={() => { setPage(page + 1); scrollToTop(); }}>Berikutnya</button>
        </div>}
      </section>
    </>}
    {!result && !busy && !error && <p className="helper">Pilih truck dan rentang waktu untuk melihat riwayat transaksi serta aktivitas reader.</p>}
    {relationRow && <RelationModal row={relationRow} api={api} close={() => setRelationRow(null)} />}
    </div>
  </>;
}
