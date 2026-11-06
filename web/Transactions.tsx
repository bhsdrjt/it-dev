import { usePermissions } from './permissions';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Combobox } from './Combobox';
import { confirmAction } from './confirm-action';
import { Icon } from './Icon';
import { ActionIcon, Details, cell, date, value } from './TransactionCard';
import { TruckActivities } from './TruckActivities';
import { LoadingLocationModal, type LoadingLocationPreview } from './LoadingLocationModal';
import { SkeletonPanel } from './SkeletonPanel';
import { analyzeTransactions, dispatcherLabel, groupTruckActivities, groupTruckTransactions, isDispatcherCreated, isNewAssignment, sameCdn, stages, transactionKind, type Row } from './transaction-analysis';
type Result = {
  coalDeliveryNumber: string;
  transactions: Row[];
  activities: Row[]
};
type Props = {
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  log: (level: 'ok' | 'err' | 'info', message: string, note?: string) => void;
  initialTarget?: { cdn: string } | null;
};
const isDeleted = (row: Row) => row.dtDeletedAt !== null && row.dtDeletedAt !== undefined;
function DeletedStatus({ row, label = 'Sudah dihapus' }: {
  row: Row;
  label?: string
}) {
  return isDeleted(row) ? <span className="deleted-status">{label} · <time>
    {date(row.dtDeletedAt)}
  </time></span> : null;
}
export function RelationModal({ row, api, close }: { row: Row; api: Props['api']; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const kind = transactionKind(row);
  const id = kind === 'Kirim' ? row.RefDumpingTonnageID : row.CTFinalTonnageID;
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    const controller = new AbortController();
    if (id == null) setRows([]);
    else void api<Row[]>(`/transactions/relations?kind=${encodeURIComponent(kind)}&dumpingTonnageId=${encodeURIComponent(String(id))}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setRows(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Relasi gagal dimuat.'); });
    return () => {
      controller.abort();
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [api, id, kind]);
  const columns = [...new Set(rows?.flatMap(item => Object.keys(item)) || [])];
  return <dialog ref={dialog} className="relation-modal" aria-labelledby="relation-modal-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="panel-heading">
      <h2 id="relation-modal-title">Cek relasi · {kind} #{value(row.CTFinalTonnageID)}</h2>
      <button type="button" autoFocus onClick={close}>Tutup</button>
    </div>
    <div className="relation-modal-body">
      <p className="helper">{kind === 'Kirim' ? 'Terima yang ditunjuk RefDumpingTonnageID' : 'Kirim yang menunjuk CTFinalDumpingTonnageID'}: {value(id)}. Data dihapus tetap ditampilkan.</p>
      {error ? <p className="error" role="alert">{error}</p> : rows === null ? <p role="status" aria-busy="true">Memuat relasi…</p> : !rows.length ? <p role="status">{id == null ? 'Kirim tidak memiliki RefDumpingTonnageID.' : 'Data relasi tidak ditemukan.'}</p> : <>
        <p role="status">{rows.length} data {kind === 'Kirim' ? 'Terima' : 'Kirim'} ditemukan.</p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabel data relasi">
          <table>
            <thead><tr><th scope="col">Status</th>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{rows.map((item, index) => <tr key={index} className={isDeleted(item) ? 'deleted-record' : ''}>
              <td>{isDeleted(item) ? <DeletedStatus row={item} /> : 'Aktif'}</td>
              {columns.map(column => <td key={column}>{cell(column, item[column])}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </>}
    </div>
  </dialog>;
}
function CardActions({ row, disabled, busy, copy, generateSk, getLoadingLocation, remove, restore }: { row: Row; disabled: boolean; busy?: boolean; copy: (row: Row) => void; generateSk: (row: Row) => void; getLoadingLocation: (row: Row) => void; remove: (row: Row) => void; restore: (row: Row) => void }) {
  const can = usePermissions();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const deleted = isDeleted(row);
  const blocked = disabled;
  const canGetLocation = transactionKind(row) === 'Kirim' && row.strStockPileName === null;
  const hasMenu = !deleted && (canGetLocation || can('transactions.delete') || (transactionKind(row) === 'Kirim' && (can('transactions.copy_loading') || can('transactions.generate_receipt'))));
  useLayoutEffect(() => {
    const menu = options.current;
    const button = trigger.current;
    if (!open || blocked || !menu || !button) return;
    // ponytail: membutuhkan Popover API (browser modern); tambah portal jika browser lama wajib didukung.
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, width - menu.offsetWidth - 8))}px`;
    const top = rect.bottom + 4 + menu.offsetHeight <= height - 8 ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
    menu.style.top = `${Math.max(8, Math.min(top, height - menu.offsetHeight - 8))}px`;
    const close = () => setOpen(false);
    const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', scroll, true);
    return () => {
      menu.hidePopover();
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, blocked]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  if (!hasMenu && !(deleted && can('transactions.restore'))) return null;
  return <div className={`card-actions${deleted ? ' card-actions-deleted' : ''}`} ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
  }}>
    {deleted && <button type="button" className="transaction-icon-button" hidden={!can('transactions.restore')} title="Pulihkan" aria-label={`Pulihkan ${transactionKind(row)} ${value(row.CTFinalTonnageID)}`} disabled={busy} onClick={() => restore(row)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
    </button>}
    <button type="button" className="transaction-icon-button" hidden={!hasMenu} title="Aksi" ref={trigger} disabled={blocked || deleted} aria-busy={!!busy} aria-expanded={open && !blocked} aria-label={`Aksi ${transactionKind(row)} ${value(row.CTFinalTonnageID)}`} onClick={() => setOpen(!open)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
    </button>
    {open && !blocked && !deleted && <div className="card-actions-options" ref={options} popover="manual">
      {canGetLocation && <button type="button" onClick={() => { trigger.current?.focus(); setOpen(false); getLoadingLocation(row); }}>Get LoadingLocation</button>}
      {can('transactions.copy_loading') && transactionKind(row) === 'Kirim' && <button type="button" disabled={!/^[\x20-\x7E]{1,20}$/.test(String(row.CoalDeliveryNumber ?? '').trim())} onClick={() => { trigger.current?.focus(); setOpen(false); copy(row); }}>Salin Muatan</button>}
      {transactionKind(row) === 'Kirim' && <button hidden={!can('transactions.generate_receipt')} type="button" disabled={!/^[\x20-\x7E]{1,20}$/.test(String(row.CoalDeliveryNumber ?? '').trim())} onClick={() => { trigger.current?.focus(); setOpen(false); generateSk(row); }}>Generate SK Terima</button>}
      <button hidden={!can('transactions.delete')} type="button" className="danger" onClick={() => { trigger.current?.focus(); setOpen(false); remove(row); }}>Hapus</button>
    </div>}
  </div>;
}
function SalinMuatanModal({ api, row, busy, close, submit, submitKeTerimaAda }: { api: Props['api']; row: Row; busy: boolean; close: () => void; submit: (cdn: string, truck: string) => void; submitKeTerimaAda: (cdn: string, truck: string, dumpingId: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cdn = String(row.CoalDeliveryNumber ?? '').trim();
  const [truck, setTruck] = useState('');
  const [localError, setLocalError] = useState('');
  const [trucks, setTrucks] = useState<string[] | null>(null);
  const [candidates, setCandidates] = useState<Row[] | null>(null);
  const [preview, setPreview] = useState<{ dtEmpty: string | null; dtLoaded: string | null } | null>(null);
  const [candidateError, setCandidateError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    const controller = new AbortController();
    // Daftar truck dari tabEquipment lewat endpoint referensi yang sudah ada.
    // Gagal memuat daftar tidak memblokir input manual; backend tetap memvalidasi.
    void api<Row[]>('/equipments?activeOnly=true', 'GET', undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setTrucks([...new Set(rows.map(row => String(row.strTruckCN ?? '').trim()).filter(name => name && name.length <= 8))].sort()); })
      .catch(() => { if (!controller.signal.aborted) setTrucks([]); });
    return () => {
      controller.abort();
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [api]);
  useEffect(() => {
    setCandidates(null);
    setPreview(null);
    setCandidateError('');
    if (!truck.trim()) return;
    const controller = new AbortController();
    void api<{ candidates: Row[]; preview?: { dtEmpty: string | null; dtLoaded: string | null } | null }>(`/transactions/salin-muatan/candidates?coalDeliveryNumber=${encodeURIComponent(cdn)}&nextDT=${encodeURIComponent(truck.trim())}`, 'GET', undefined, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setCandidates(data.candidates || []);
        setPreview(data.preview ?? null);
      })
      .catch(cause => { if (!controller.signal.aborted) setCandidateError(cause instanceof Error ? cause.message : 'Pemeriksaan SK terima gagal.'); });
    return () => controller.abort();
  }, [api, cdn, truck]);
  // Kandidat terdekat dipakai otomatis; tanpa kandidat, procedure membuat Terima baru.
  const candidate = candidates?.[0];
  const checking = !!truck.trim() && candidates === null && !candidateError;
  return <dialog ref={dialog} className="relation-modal salin-modal" aria-labelledby="salin-modal-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      const number = cdn.trim();
      const name = truck.trim();
      if (!/^[\x20-\x7E]{1,20}$/.test(number)) { setLocalError('CoalDeliveryNumber maksimal 20 karakter ASCII tanpa karakter kontrol.'); return; }
      if (!/^[\x20-\x7E]{1,8}$/.test(name)) { setLocalError('NoTruck maksimal 8 karakter ASCII tanpa karakter kontrol.'); return; }
      if (checking) { setLocalError('Tunggu pemeriksaan SK terima selesai.'); return; }
      setLocalError('');
      if (candidate) {
        const dumpingId = Number(candidate.CTFinalDumpingTonnageID);
        if (!Number.isInteger(dumpingId) || dumpingId <= 0 || dumpingId > 2147483647) { setLocalError('SK terima hasil pemeriksaan tidak valid.'); return; }
        if (!await confirmAction(`Salin muatan SK ${number} ke truck ${name} memakai Terima #${dumpingId} (${value(candidate.CoalDeliveryNumber)})?\n\nMenjalankan dbo.usp_SalinMuatanKeTerimaAda. Kirim sumber dipindah ke truck ${name} (EquipmentID, nama truck, company ikut berubah) dan dipasangkan ke Terima #${dumpingId}; trigger menyamakan CoalDeliveryNumber Terima dengan SK ${number}. Procedure memakai transaksi internal; jika koneksi terputus, periksa hasil sebelum mengulang. Lanjutkan?`)) return;
        submitKeTerimaAda(number, name, dumpingId);
        return;
      }
      if (!await confirmAction(`Salin muatan SK ${number} ke truck ${name}?\n\nTidak ada SK terima belum berpasangan yang cocok, sehingga dbo.usp_SalinMuatan akan membuat Terima baru dari timbang muat/kosong berikutnya pada truck ${name}. Procedure melepas relasi semua Kirim dengan SK ${number} lebih dulu. Procedure memakai transaksi internal; jika koneksi terputus, periksa hasil sebelum mengulang. Lanjutkan?`)) return;
      submit(number, name);
    }}>
      <div className="panel-heading">
        <h2 id="salin-modal-title">Salin muatan</h2>
        <button type="button" onClick={close} disabled={busy}>Tutup</button>
      </div>
      <div className="relation-modal-body salin-modal-body">
        <p className="salin-source">Truck sumber: <strong>{value(row.strEquipmentName)}</strong> · Kirim #{value(row.CTFinalTonnageID)}
          <span className="helper">Muat {date(row.dtLoaded)} · kosong {date(row.dtEmpty)}</span>
        </p>
        <label htmlFor="salin-cdn">CoalDeliveryNumber sumber<input id="salin-cdn" value={cdn} readOnly /></label>
        <label htmlFor="salin-truck">NoTruck tujuan (strTruckCN)
          <Combobox id="salin-truck" value={truck} onChange={setTruck} options={trucks ?? []} placeholder={trucks === null ? 'Memuat daftar truck…' : 'Contoh: TR10061'} required maxLength={8} disabled={busy} />
          {trucks !== null && !trucks.length && <span className="helper">Daftar truck tidak tersedia; ketik NoTruck manual. Backend tetap memvalidasi.</span>}
        </label>
        {checking && <p className="helper" role="status" aria-busy="true">Memeriksa SK terima untuk truck {truck}…</p>}
        {!checking && candidate && <p className="helper" role="status">SK terima #{value(candidate.CTFinalDumpingTonnageID)} ({value(candidate.CoalDeliveryNumber)}) · muat {date(candidate.dtLoaded)} · kosong {date(candidate.dtEmpty)} akan dipakai.</p>}
        {!checking && truck.trim() && candidates !== null && !candidate && preview && <p className="helper" role="status">Tidak ada SK terima belum berpasangan; procedure akan membuat Terima baru · muat {date(preview.dtLoaded)} · kosong {date(preview.dtEmpty)}.</p>}
        {!checking && truck.trim() && candidates !== null && !candidate && !preview && <p className="helper" role="status">Tidak ada SK terima belum berpasangan dan tidak ada data timbang kosong yang cocok; procedure akan gagal dengan pesan Kosong Terima tidak ditemukan.</p>}
        {candidateError && <p className="error" role="alert">{candidateError} Periksa koneksi lalu ubah NoTruck untuk memeriksa ulang.</p>}
        {localError && <p className="error" role="alert">{localError}</p>}
        <button className="primary" aria-busy={busy || checking} disabled={busy || !cdn.trim() || !truck.trim() || checking || !!candidateError}>
          {busy ? 'Menjalankan procedure…' : checking ? 'Memeriksa SK terima…' : 'Salin muatan'}
        </button>
      </div>
    </form>
  </dialog>;
}
export function Transactions({ api, log, initialTarget = null }: Props) {
  const can = usePermissions();
  const [relationRow, setRelationRow] = useState<Row | null>(null);
  const [loadingLocationRow, setLoadingLocationRow] = useState<Row | null>(null);
  const [cdn, setCdn] = useState(initialTarget?.cdn ?? '');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promotionMessage, setPromotionMessage] = useState('');
  const promotionPending = useRef(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseMessage, setReleaseMessage] = useState('');
  const releasePending = useRef(false);
  const [salinRow, setSalinRow] = useState<Row | null>(null);
  const [salining, setSalining] = useState(false);
  const [salinMessage, setSalinMessage] = useState('');
  const salinPending = useRef(false);
  const [promotionNeedsReload, setPromotionNeedsReload] = useState(false);
  // Baris yang sedang diproses; loading hanya pada baris itu, bukan semua kartu.
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [tab, setTab] = useState<'timeline' | 'raw' | 'activity' | 'analysis'>('timeline');
  // Ref mencegah submit ganda; abort saat unmount mencegah respons lama mengisi halaman.
  // Membatalkan browser tidak menjamin stored procedure di server ikut berhenti.
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const search = useCallback(async (searchCdn: string) => {
    if (pending.current || promotionPending.current || releasePending.current || salinPending.current) return;
    const number = searchCdn.trim();
    setError('');
    setResult(null);
    if (!/^[\x20-\x7E]{1,50}$/.test(number)) {
      setError('Isi CoalDeliveryNumber, maksimal 50 karakter ASCII tanpa karakter kontrol.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setTab('timeline');
    log('info', `Memuat analisa transaksi ${number}.`);
    try {
      const data = await api<Result>(`/transactions/timeline?coalDeliveryNumber=${encodeURIComponent(number)}`, 'GET', undefined, controller.signal);
      if (controller.signal.aborted) return;
      setResult(data);
      setPromotionNeedsReload(false);
      setPromotionMessage('');
      setReleaseMessage('');
      setSalinMessage('');
      log('ok', `Analisa transaksi ${data.coalDeliveryNumber} dimuat.`, `${data.transactions.length} transaksi; ${data.activities.length} aktivitas.`);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const text = cause instanceof Error ? cause.message : 'Analisa transaksi gagal dimuat.';
      setError(text);
      log('err', text);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [api, log]);
  // Objek target baru untuk setiap klik Monitoring, termasuk SK yang sama.
  const consumedTarget = useRef<Props['initialTarget']>(null);
  useEffect(() => {
    if (!initialTarget || consumedTarget.current === initialTarget || promoting || releasing || salining) return;
    // Jangan menimpa refresh hasil mutasi yang masih berjalan.
    if (promotionPending.current || releasePending.current || salinPending.current) return;
    consumedTarget.current = initialTarget;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setCdn(initialTarget.cdn);
    setLoadingLocationRow(null);
    setRelationRow(null);
    setSalinRow(null);
    void search(initialTarget.cdn);
  }, [initialTarget, promoting, releasing, salining, search]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void search(cdn);
  }
  async function reloadTimeline(searchCdn: string) {
    try {
      const refreshed = await api<Result>(`/transactions/timeline?coalDeliveryNumber=${encodeURIComponent(searchCdn)}`);
      setResult(refreshed);
      setPromotionNeedsReload(false);
    } catch {
      setError('Perubahan selesai atau gagal di server, tetapi hasil terbaru gagal dimuat. Cari ulang SK untuk memeriksa hasil; jangan langsung mengulang.');
    }
  }
  async function promoteRaw(row: Row) {
    if (promotionPending.current || releasePending.current || pending.current || salinPending.current || promotionNeedsReload || !result) return;
    const id = Number(row.CTFinalTonnageID);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647 || isDeleted(row)) return;
    if (!await confirmAction(`Masukkan RawTerima #${id} (SK ${value(row.CoalDeliveryNumber)}) ke data Terima?\n\nMenjalankan dbo.usp_DebugCTFinalDumpingTonnagebyID berdasarkan ID raw baris ini. Procedure dapat memperbarui relasi Kirim dan menandai transaksi lama dihapus sesuai aturan timbang ulang. Raw tidak dihapus oleh tombol ini. Lanjutkan?`)) return;
    promotionPending.current = true;
    setPromoting(true);
    setActiveRow(id);
    setPromotionNeedsReload(true);
    setPromotionMessage('');
    setError('');
    try {
      const response = await api<{ message: string }>('/transactions/raw-terima', 'POST', { rawTonnageId: id, confirmed: true });
      setPromotionMessage(response.message);
      log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      const rejected = cause instanceof Error && 'status' in cause && [400, 404, 409].includes(Number(cause.status));
      // Procedure rollback internal saat gagal. 503 / timeout = status tidak diketahui: kunci tombol hingga muat ulang.
      if (!timedOut && !rejected) setPromotionNeedsReload(true);
      const message = `${cause instanceof Error ? cause.message : 'Hasil pemrosesan RawTerima belum dapat dipastikan.'} Muat ulang melalui Analisa transaksi sebelum mencoba lagi.`;
      setError(message);
      log('err', message);
    } finally {
      promotionPending.current = false;
      setPromoting(false);
      setActiveRow(null);
    }
  }
  async function releaseRelation(loading: Row, pair = false) {
    if (releasePending.current || pending.current || promotionPending.current || salinPending.current || promotionNeedsReload || !result) return;
    const id = Number(loading.CTFinalTonnageID);
    const ref = Number(loading.RefDumpingTonnageID);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return;
    if (pair ? loading.RefDumpingTonnageID != null || isDeleted(loading) : loading.RefDumpingTonnageID == null || !Number.isInteger(ref)) return;
    const confirmation = pair
      ? `Pasangkan Kirim #${id} (SK ${value(loading.CoalDeliveryNumber)}) dengan satu Terima?\n\nProcedure memilih Terima aktif pada truck sama dengan dtEmpty >= dtLoaded Kirim, menurut dtEmpty paling awal. Pilihan tidak dibatasi SK atau ritase berikutnya dan bukan berdasarkan posisi kartu. Trigger dapat memperbarui SK, kualitas batu, dan data terkait Terima. Lanjutkan?`
      : `Lepas relasi Kirim #${id} (SK ${value(loading.CoalDeliveryNumber)}) dari Terima #${ref}?\n\nMengatur CTFinalDumpingTonnageID menjadi NULL. Relasi tidak dibuat ulang otomatis dan Terima tidak dihapus. Lanjutkan?`;
    if (!await confirmAction(confirmation)) return;
    releasePending.current = true;
    setReleasing(true);
    setPromotionNeedsReload(true);
    setReleaseMessage('');
    setPromotionMessage('');
    setError('');
    try {
      const response = await api<{ message: string }>(pair ? '/transactions/relations/pair' : '/transactions/relations', 'POST', { loadingTonnageId: id, confirmed: true });
      setReleaseMessage(response.message);
      log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      const rejected = cause instanceof Error && 'status' in cause && [400, 404, 409].includes(Number(cause.status));
      // Procedure rollback internal saat gagal. 503 / timeout = status tidak diketahui: kunci tombol hingga muat ulang.
      if (!timedOut && !rejected) setPromotionNeedsReload(true);
      const message = timedOut
        ? 'Batas tunggu respons terlampaui. Status perubahan belum diketahui; request di server mungkin masih berjalan. Muat ulang melalui Analisa transaksi dan periksa relasi sebelum mencoba lagi.'
        : `${cause instanceof Error ? cause.message : 'Hasil perubahan relasi belum dapat dipastikan.'} Muat ulang melalui Analisa transaksi sebelum mencoba lagi.`;
      setError(message);
      log('err', message);
    } finally {
      releasePending.current = false;
      setReleasing(false);
      setActiveRow(null);
    }
  }
  const salinMuatan = async (number: string, truck: string, dumpingId?: number) => {
    const keTerimaAda = dumpingId !== undefined;
    if (salinPending.current || releasePending.current || pending.current || promotionPending.current || promotionNeedsReload) return;
    salinPending.current = true;
    setSalining(true);
    setPromotionNeedsReload(true);
    setSalinMessage('');
    setPromotionMessage('');
    setReleaseMessage('');
    setError('');
    log('info', keTerimaAda
      ? `Menjalankan Salin muatan SK ${number} ke truck ${truck} memakai Terima #${dumpingId}.`
      : `Menjalankan Salin muatan SK ${number} ke truck ${truck}.`);
    try {
      const response = await api<{ message: string }>(keTerimaAda ? '/transactions/salin-muatan/ke-terima-ada' : '/transactions/salin-muatan', 'POST', keTerimaAda
        ? { coalDeliveryNumber: number, nextDT: truck, ctFinalDumpingTonnageId: dumpingId, confirmed: true }
        : { coalDeliveryNumber: number, nextDT: truck, confirmed: true });
      setSalinMessage(response.message);
      log('ok', response.message);
      if (result) await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const rejected = cause instanceof Error && 'status' in cause && [400, 404, 409].includes(Number(cause.status));
      if (rejected) setPromotionNeedsReload(false);
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      const action = keTerimaAda ? 'Salin muatan ke SK terima' : 'Salin muatan';
      const message = rejected ? cause.message : timedOut
        ? `Batas tunggu respons terlampaui. Status ${action} belum diketahui; request di server mungkin masih berjalan. Muat ulang melalui Analisa transaksi dan periksa relasi sebelum mencoba lagi.`
        : `${cause instanceof Error ? cause.message : `Hasil ${action} belum dapat dipastikan.`} Muat ulang melalui Analisa transaksi sebelum mencoba lagi.`;
      setError(message);
      log('err', message);
    } finally {
      salinPending.current = false;
      setSalining(false);
      setSalinRow(null);
    }
  }
  async function saveLoadingLocation(preview: LoadingLocationPreview) {
    const row = loadingLocationRow;
    if (!row || !result || releasePending.current || pending.current || salinPending.current || promotionPending.current || promotionNeedsReload || isDeleted(row) || row.strStockPileName !== null) return;
    releasePending.current = true; setReleasing(true); setActiveRow(Number(row.CTFinalTonnageID));
    setPromotionNeedsReload(true); setError(''); setReleaseMessage(''); setPromotionMessage(''); setSalinMessage('');
    try {
      const response = await api<{ message: string }>('/transactions/loading-location', 'POST', { loadingTonnageId: Number(row.CTFinalTonnageID), previewToken: preview.previewToken, confirmed: true });
      setReleaseMessage(response.message); log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const rejected = cause instanceof Error && 'status' in cause && [400, 403, 404, 409].includes(Number(cause.status));
      if (rejected) setPromotionNeedsReload(false);
      const message = `${cause instanceof Error ? cause.message : 'Get LoadingLocation gagal.'}${rejected ? ' Buka kembali preview untuk memeriksa data terbaru.' : ' Status belum pasti. Muat ulang analisa sebelum mencoba lagi.'}`;
      setError(message); log('err', message);
    } finally {
      releasePending.current = false; setReleasing(false); setActiveRow(null); setLoadingLocationRow(null);
    }
  }
  async function generateSkTerima(row: Row) {
    if (releasePending.current || pending.current || salinPending.current || promotionPending.current || promotionNeedsReload || !result || isDeleted(row)) return;
    const cdn = String(row.CoalDeliveryNumber ?? '').trim();
    if (!/^[\x20-\x7E]{1,20}$/.test(cdn)) return;
    if (!await confirmAction(`Generate SK Terima untuk SK ${cdn}?\n\nMenjalankan dbo.usp_DataHilang: melepas relasi (CTFinalDumpingTonnageID menjadi NULL) pada semua Kirim dengan SK ini, lalu membuat Terima baru dari timbang muat/kosong berikutnya pada truck sumber. Procedure bertransaksi internal: gagal berarti rollback. Lanjutkan?`)) return;
    releasePending.current = true;
    setReleasing(true);
    setActiveRow(Number(row.CTFinalTonnageID));
    setPromotionNeedsReload(true);
    setReleaseMessage(''); setPromotionMessage(''); setSalinMessage(''); setError('');
    try {
      const response = await api<{ message: string }>('/transactions/generate-sk-terima', 'POST', { coalDeliveryNumber: cdn, confirmed: true });
      setReleaseMessage(response.message);
      log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      const rejected = cause instanceof Error && 'status' in cause && [400, 404, 409].includes(Number(cause.status));
      // Procedure rollback internal saat gagal. 503 / timeout = status tidak diketahui: kunci tombol hingga muat ulang.
      if (!timedOut && !rejected) setPromotionNeedsReload(true);
      const message = timedOut
        ? 'Batas tunggu respons terlampaui. Status Generate SK Terima belum diketahui; request di server mungkin masih berjalan. Muat ulang melalui Analisa transaksi dan periksa hasil sebelum mencoba lagi.'
        : `${cause instanceof Error ? cause.message : 'Generate SK Terima gagal.'} Procedure rollback, data tidak berubah. Periksa pesan lalu coba lagi.`;
      setError(message); log('err', message);
    } finally {
      releasePending.current = false;
      setReleasing(false);
      setActiveRow(null);
    }
  }
  async function deleteTransaction(row: Row) {
    if (salinPending.current || releasePending.current || pending.current || promotionPending.current || promotionNeedsReload || !result || isDeleted(row)) return;
    const kind = transactionKind(row);
    const tonnageId = Number(row.CTFinalTonnageID);
    if (!['Kirim', 'Terima'].includes(kind) || !Number.isInteger(tonnageId) || tonnageId <= 0 || tonnageId > 2147483647) return;
    if (!await confirmAction(`Hapus ${kind} #${tonnageId}, SK ${value(row.CoalDeliveryNumber)}, truck ${value(row.strEquipmentName)}?\n\nData ditandai dihapus dengan dtDeletedAt = GETDATE(), bukan dihapus permanen. Aksi ini tidak secara eksplisit melepas relasi atau menghapus pasangan; trigger DB dapat menimbulkan efek tambahan. Lanjutkan?`)) return;
    releasePending.current = true;
    setReleasing(true);
    setActiveRow(tonnageId);
    setPromotionNeedsReload(true);
    setPromotionMessage(''); setReleaseMessage(''); setSalinMessage(''); setError('');
    try {
      const response = await api<{ message: string }>('/transactions/delete', 'POST', { kind, tonnageId, confirmed: true });
      setReleaseMessage(response.message);
      log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      const rejected = cause instanceof Error && 'status' in cause && [400, 404, 409].includes(Number(cause.status));
      // Procedure rollback internal saat gagal. 503 / timeout = status tidak diketahui: kunci tombol hingga muat ulang.
      if (!timedOut && !rejected) setPromotionNeedsReload(true);
      const message = `${cause instanceof Error ? cause.message : 'Hasil penghapusan belum dapat dipastikan.'} Periksa pesan lalu coba lagi.`;
      setError(message); log('err', message);
    } finally {
      releasePending.current = false;
      setReleasing(false);
      setActiveRow(null);
    }
  }
  async function restoreTransaction(row: Row) {
    if (salinPending.current || releasePending.current || pending.current || promotionPending.current || promotionNeedsReload || !result || !isDeleted(row)) return;
    const kind = transactionKind(row);
    const tonnageId = Number(row.CTFinalTonnageID);
    if (!['Kirim', 'Terima'].includes(kind) || !Number.isInteger(tonnageId) || tonnageId <= 0 || tonnageId > 2147483647) return;
    if (!await confirmAction(`Pulihkan ${kind} #${tonnageId}, SK ${value(row.CoalDeliveryNumber)}, truck ${value(row.strEquipmentName)}?\n\nData dikembalikan aktif dengan dtDeletedAt = NULL dan dtUpdatedAt = GETDATE(). Relasi dan pasangan tidak dibuat ulang otomatis; trigger DB dapat menimbulkan efek tambahan. Lanjutkan?`)) return;
    releasePending.current = true;
    setReleasing(true);
    setActiveRow(tonnageId);
    setPromotionNeedsReload(true);
    setPromotionMessage(''); setReleaseMessage(''); setSalinMessage(''); setError('');
    try {
      const response = await api<{ message: string }>('/transactions/restore', 'POST', { kind, tonnageId, confirmed: true });
      setReleaseMessage(response.message);
      log('ok', response.message);
      await reloadTimeline(result.coalDeliveryNumber);
    } catch (cause) {
      const timedOut = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name);
      // Transaksi DB rollback saat gagal; error definitif berarti data tidak berubah, buka kunci tombol.
      if (!timedOut) setPromotionNeedsReload(false);
      const message = `${cause instanceof Error ? cause.message : 'Hasil pemulihan belum dapat dipastikan.'} Periksa pesan lalu coba lagi.`;
      setError(message); log('err', message);
    } finally {
      releasePending.current = false;
      setReleasing(false);
      setActiveRow(null);
    }
  }
  const actions = (row: Row) => <CardActions row={row} busy={activeRow === Number(row.CTFinalTonnageID) && (promoting || releasing)} disabled={busy || promoting || releasing || salining || promotionNeedsReload || isDeleted(row)} copy={setSalinRow} getLoadingLocation={setLoadingLocationRow} generateSk={row => void generateSkTerima(row)} remove={row => void deleteTransaction(row)} restore={row => void restoreTransaction(row)} />;
  // Pisahkan tampilan final/raw, tetapi analisa tetap menerima snapshot lengkap.
  // CDN pembanding diperlukan untuk mendeteksi referensi milik ritase lain.
  const transactions = result?.transactions.filter(row => transactionKind(row) !== 'TerimaRaw') || [];
  const transactionGroups = groupTruckTransactions(transactions);
  const raw = result?.transactions.filter(row => transactionKind(row) === 'TerimaRaw') || [];
  const target = result?.transactions.filter(row => sameCdn(row, result.coalDeliveryNumber)) || [];
  const columns = [...new Set(raw.flatMap(row => Object.keys(row)))];
  const activities = result?.activities || [];
  // ponytail: ambang dari definisi procedure operator; gunakan metadata server jika tersedia.
  const activityGroups = groupTruckActivities(activities, result?.transactions ?? []);
  const targetRow = target[0];
  const truckRow = targetRow?.strEquipmentName ? targetRow : result?.transactions[0];
  const analysis = result ? analyzeTransactions(result.transactions, activities, result.coalDeliveryNumber) : null;
  const unpaired = new Set(analysis?.pairs.flatMap(pair => pair.unpairedDumping ? [pair.loading, pair.unpairedDumping] : []) || []);
  const beforeCdn = new Set(analysis?.journeys.flatMap(journey => journey.candidates.filter(event => event.basis === 'Urutan sebelum SK terbit').map(event => event.row)) || []);
  const inTrip = new Set(analysis?.journeys.flatMap(journey => journey.candidates.filter(event => event.basis === 'Urutan ritase hingga Terima Kosong').map(event => event.row)) || []);
  return <div className="transaction-workspace">
    {loadingLocationRow && <LoadingLocationModal row={loadingLocationRow} api={api} close={() => setLoadingLocationRow(null)} save={saveLoadingLocation} busy={releasing} />}
    {relationRow && <RelationModal row={relationRow} api={api} close={() => setRelationRow(null)} />}
    {salinRow && <SalinMuatanModal api={api} row={salinRow} busy={salining} close={() => setSalinRow(null)} submit={(number, truck) => void salinMuatan(number, truck)} submitKeTerimaAda={(number, truck, dumpingId) => void salinMuatan(number, truck, dumpingId)} />}
    <div className="page-heading">
      <h1 id="transactions-title">Analisa transaksi</h1>
    </div>
    <form className="transaction-search" onSubmit={submit}>
      <label htmlFor="coal-delivery-number">CoalDeliveryNumber<input id="coal-delivery-number" value={cdn} onChange={e => setCdn(e.target.value)} placeholder="Contoh: AF260080419" required maxLength={50} disabled={busy || promoting || releasing || salining} autoComplete="off" /></label>
      <button className="primary transaction-icon-button" title="Analisa transaksi" aria-label="Analisa transaksi" aria-busy={busy} disabled={busy || promoting || releasing || salining || !cdn.trim()}>
        <Icon name="search" />
      </button>
      {busy && <button type="button" onClick={() => {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        log('info', 'Permintaan analisa dibatalkan di browser.');
      }}>Batalkan</button>}
    </form>
    {error && <div className="error dismissible-notice" role="alert">
      <span>{error}</span>
      <button type="button" aria-label="Tutup notifikasi" title="Tutup notifikasi" onClick={() => setError('')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>}
    {(promoting || releasing || salining || promotionMessage || releaseMessage || salinMessage) && <div className="success dismissible-notice" role="status" aria-busy={promoting || releasing || salining}>
      <span>{promoting || releasing || salining ? 'Memproses perubahan; jangan tutup halaman atau mengulang request…' : promotionMessage || releaseMessage || salinMessage}</span>
      {!promoting && !releasing && !salining && <button type="button" aria-label="Tutup notifikasi" title="Tutup notifikasi" onClick={() => { setPromotionMessage(''); setReleaseMessage(''); setSalinMessage(''); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>}
    </div>}
    {busy ? <SkeletonPanel title="Analisa transaksi" subtitle="Menjalankan stored procedure untuk SK dicari. Batas waktu query 60 detik." rows={4} /> : result ? <>
      <section className="transaction-summary" aria-label="Ringkasan SK">
        <div>
          <span>SK dicari</span>
          <strong>
            {result.coalDeliveryNumber}
          </strong>
        </div>
        <div>
          <span>Truck</span>
          <strong>
            {value(truckRow?.strEquipmentName || activities[0]?.strTruckCN)}{truckRow?.EquipmentID != null ? ` #${truckRow.EquipmentID}` : ''}
          </strong>
        </div>
        {['Kirim', 'Terima', 'TerimaRaw'].map(kind => <div key={kind}>
          <span>{kind} · SK ini</span>
          <strong>
            {target.filter(row => transactionKind(row) === kind).length}
          </strong>
        </div>)}
      </section>
      <div className="transaction-coverage" role="status" aria-label="Cakupan hasil procedure">
        Hasil dibatasi jumlah baris dan jendela waktu procedure. Data yang tidak muncul belum tentu tidak ada.
      </div>
      <nav className="view-tabs" aria-label="Hasil analisa transaksi">
        <button aria-pressed={tab === 'timeline'} onClick={() => setTab('timeline')}>Kirim / Terima <span className="count">
          {transactions.length}
        </span></button>
        <button aria-pressed={tab === 'raw'} onClick={() => setTab('raw')}>TerimaRaw <span className="count">
          {raw.length}
        </span></button>
        <button aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Aktivitas truck <span className="count">
          {activities.length}
        </span></button>
        <button aria-pressed={tab === 'analysis'} onClick={() => setTab('analysis')}>Analisa anomali</button>
      </nav>
      <section className="panel transaction-results" aria-label={tab === 'analysis' ? 'Analisa anomali' : tab === 'timeline' ? 'Timeline Kirim dan Terima' : tab === 'raw' ? 'Data TerimaRaw' : 'Detail aktivitas truck'}>
        <div className="panel-heading">
          <h2>
            {tab === 'analysis' ? 'Pasangan transaksi & anomali ritase' : tab === 'timeline' ? 'Timeline Kirim / Terima' : tab === 'raw' ? 'Data TerimaRaw' : 'Detail aktivitas truck'}
          </h2>
          <span className="helper">
            {tab === 'analysis' ? 'Pemeriksaan hasil yang tersedia' : tab === 'activity' ? 'Dikelompokkan per ritase' : tab === 'timeline' ? 'Dikelompokkan per ritase' : 'Semua kolom hasil procedure'}
          </span>
        </div>
        {tab === 'analysis' && analysis ? <div className="anomaly-content">
          <p className="helper">Pasangan tersimpan dibaca melalui <code>Kirim.RefDumpingTonnageID = Terima.CTFinalTonnageID</code>, lalu diuji terhadap ritase fisik: truck yang sama, dtLoaded Terima cocok dengan Muat Terima, dan dtEmpty cocok dengan Kosong Terima. Referensi/SK tersimpan bisa salah. Kandidat berbasis waktu tidak mengubah data otomatis; penyebab seperti network down perlu bukti log.</p>
          <h3>Pasangan Kirim / Terima</h3>
          {!analysis.pairs.length && <p className="error">Kirim tidak terlihat pada hasil procedure. Pasangan belum dapat diperiksa.</p>}
          {analysis.pairs.map(({ loading, dumping, findings }, index) => <article className={`pair-card ${sameCdn(loading, result.coalDeliveryNumber) ? 'target-pair' : ''} ${isDeleted(loading) ? 'deleted-record' : ''}`} key={index}>
            <div className="transaction-title">
              <h3>Kirim #{value(loading.CTFinalTonnageID)} · {value(loading.CoalDeliveryNumber)}</h3>
              {actions(loading)}
              <span className="status">
                {sameCdn(loading, result.coalDeliveryNumber) ? 'SK dicari' : 'Ritase pembanding'}
              </span>
            </div>
            <p className="transaction-meta">
              <span>RefDumpingTonnageID: <strong>
                {value(loading.RefDumpingTonnageID)}
              </strong>
                {loading.RefDumpingTonnageID == null && <button type="button" className="transaction-icon-button" hidden={!can('transactions.pair')} title="Pasangkan Terima" aria-busy={activeRow === Number(loading.CTFinalTonnageID) && releasing} disabled={releasing || promoting || promotionNeedsReload || isDeleted(loading)} onClick={() => void releaseRelation(loading, true)} aria-label={`Pasangkan Terima untuk Kirim ${value(loading.CTFinalTonnageID)}`}>
                  <ActionIcon action="link" />
                </button>}
                {loading.RefDumpingTonnageID !== null && loading.RefDumpingTonnageID !== undefined && <button type="button" className="transaction-icon-button" hidden={!can('transactions.unpair')} title="Lepas Relasi" aria-busy={activeRow === Number(loading.CTFinalTonnageID) && releasing} disabled={releasing || promoting || promotionNeedsReload} onClick={() => void releaseRelation(loading)} aria-label={`Lepas relasi Kirim ${value(loading.CTFinalTonnageID)} dari Terima ${value(loading.RefDumpingTonnageID)}`}>
                  <ActionIcon action="unlink" />
                </button>}
              </span>
              <span>Terima: <strong>
                {dumping ? `#${value(dumping.CTFinalTonnageID)} · ${value(dumping.CoalDeliveryNumber)}` : 'Belum terverifikasi'}
              </strong></span>
            </p>
            {(isDispatcherCreated(loading) || (dumping && isDispatcherCreated(dumping))) && <p className="transaction-meta">
              {isDispatcherCreated(loading) && <span className="status unknown" title="Penanda berdasarkan dtTimeCollected dengan milidetik 000, bukan audit pembuat.">Kirim · {dispatcherLabel(loading)}</span>}
              {dumping && isDispatcherCreated(dumping) && <span className="status unknown" title="Penanda berdasarkan dtTimeCollected dengan milidetik 000, bukan audit pembuat.">Terima · {dispatcherLabel(dumping)}</span>}
            </p>}
            <DeletedStatus row={loading} label="Kirim sudah dihapus" />
            {dumping && <DeletedStatus row={dumping} label="Terima sudah dihapus" />}
            {findings.length ? <ul className="finding-list">
              {findings.map((finding, i) => <li key={i} className={`finding-${finding.level}`}><strong>
                {finding.level === 'warn' ? 'Perlu diperiksa' : 'Catatan'}
              </strong> · {finding.text}</li>)}
            </ul> : <p className="pair-ok">ID referensi dan SK pasangan cocok pada hasil yang tersedia.</p>}
          </article>)}
          <h3>Urutan aktivitas · SK {result.coalDeliveryNumber}</h3>
          <p className="helper">Urutan: Kosong Kirim, MT (opsional), Muat Kirim, Tollgate, Muat Terima, Kosong Terima. Ritase SK dimulai saat Kosong Kirim dan berakhir pada Terima Kosong. Aktivitas di antaranya tetap satu SK, meskipun SK baru terbit saat Muat Kirim; aktivitas setelah Terima Kosong tidak ikut. MT adalah reader RFID di front loading untuk mengenali asal batu. Tanpa pembacaan MT, operator dapat memilih asal batu manual di timbangan; bukan anomali. Tollgate boleh 1–2x; pembacaan MT berulang tidak otomatis anomali.</p>
          {!analysis.journeys.length && <p className="error">Kirim SK dicari tidak terlihat. Batas ritase dan kelengkapan aktivitas belum terverifikasi.</p>}
          {analysis.journeys.map((journey, index) => <article className={`pair-card ${isDeleted(journey.loading) ? 'deleted-record' : ''}`} key={index}>
            <DeletedStatus row={journey.loading} label="Kirim sudah dihapus" />
            <h3>Kirim #{value(journey.loading.CTFinalTonnageID)}</h3>
            <p className="helper">Awal ritase: {date(journey.start)} · Akhir ritase · Terima Kosong (termasuk): {journey.end ? date(journey.end) : 'Belum terlihat'}</p>
            <ol className="stage-counts">
              {stages.map((stage, i) => <li key={stage}>
                <span>
                  {stage}
                  {i === 1 ? ' (opsional)' : ''}
                </span>
                <strong>{journey.counts[i]}x</strong>
              </li>)}
            </ol>
            <ul className="finding-list">
              {journey.findings.map((finding, i) => <li key={i} className={`finding-${finding.level}`}><strong>
                {finding.level === 'warn' ? 'Indikasi anomali' : 'Catatan'}
              </strong> · {finding.text}</li>)}
            </ul>
            {!!journey.candidates.length && <details className="transaction-details">
              <summary>Aktivitas yang diperiksa ({journey.candidates.length})</summary>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Bukti aktivitas ritase">
                <table>
                  <thead>
                    <tr>
                      <th>Waktu</th>
                      <th>Aktivitas</th>
                      <th>Reader / lokasi assignment</th>
                      <th>SK</th>
                      <th>Dasar pemilihan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journey.candidates.map(({ row, basis }, i) => <tr key={i}>
                      <td>
                        {date(row.dtTimeCollected)}
                      </td>
                      <td>
                        {value(row.trans)}
                      </td>
                      <td>
                        {isNewAssignment(row) ? `Muat: ${value(row.LoadingLocationName)} · Bongkar: ${value(row.DumpingLocationName)}` : value(row.ReaderLocationName)}
                      </td>
                      <td>
                        {value(row.CoalDeliveryNumber)}
                      </td>
                      <td>
                        {basis}
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </details>}
          </article>)}
        </div> : tab === 'raw' ? raw.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabel TerimaRaw">
          <table>
            <thead>
              <tr>
                <th scope="col">Aksi</th>
                <th scope="col">Status penghapusan</th>
                {columns.map(key => <th key={key} scope="col">
                  {key}
                </th>)}
              </tr>
            </thead>
            <tbody>
              {raw.map((row, index) => <tr key={index} className={`${sameCdn(row, result.coalDeliveryNumber) ? 'selected-row' : ''} ${isDeleted(row) ? 'deleted-record' : ''}`}>
                <td>
                  <button type="button" className="transaction-icon-button" hidden={!can('transactions.replay_raw')} title="Masukkan ke Terima" aria-busy={activeRow === Number(row.CTFinalTonnageID) && promoting} disabled={promoting || releasing || promotionNeedsReload || isDeleted(row) || !Number.isInteger(Number(row.CTFinalTonnageID)) || Number(row.CTFinalTonnageID) <= 0 || Number(row.CTFinalTonnageID) > 2147483647} onClick={() => void promoteRaw(row)} aria-label={`Masukkan RawTerima ${value(row.CTFinalTonnageID)} ke Terima`}>
                    <ActionIcon action="receive" />
                  </button>
                </td>
                <td>
                  {isDeleted(row) ? <DeletedStatus row={row} /> : '—'}
                </td>
                {columns.map(key => <td key={key}>
                  {cell(key, row[key])}
                </td>)}
              </tr>)}
            </tbody>
          </table>
        </div> : <div className="empty">
          <h3>TerimaRaw tidak muncul dalam hasil procedure</h3>
          <p>Batas jumlah baris dan jendela waktu tetap berlaku.</p>
        </div> : tab === 'activity' ? activities.length ? <TruckActivities groups={activityGroups} offset={0} searchedCdn={result.coalDeliveryNumber} beforeCdn={beforeCdn} inTrip={inTrip} /> : <div className="empty">
          <h3>Aktivitas truck tidak muncul dalam hasil procedure</h3>
          <p>MT, Net Reader, Check Point, atau Tol Gate hanya ditampilkan jika dikembalikan procedure. Aktivitas tanpa SK tidak otomatis dianggap milik SK dicari.</p>
        </div> : transactions.length ? <div className="truck-trips" tabIndex={0} role="region" aria-label="Ritase Kirim / Terima">
          <p className="helper">Kelompok berdasarkan RefDumpingTonnageID, bukan SK saja. Pasangan hanya mencakup hasil procedure; transaksi tanpa pasangan tetap ditampilkan.</p>
          {transactionGroups.map((group, groupIndex) => <section className="truck-trip" key={groupIndex} aria-label={`Ritase ${groupIndex + 1}`}>
            <header className="trip-heading"><div><h3>Ritase {groupIndex + 1} · SK {group.sk.join(', ') || 'belum tercatat'}</h3><p>Mulai {date(group.start)} · Selesai {date(group.end)}</p></div><span className={`status ${group.status === 'Terhubung' ? 'online' : 'unknown'}`}>{group.status}</span></header>
            {!!group.notes.length && <ul className="trip-notes">{group.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
            <ol className="transaction-timeline">
          {group.rows.map((row, index) => <li key={index} className={`${sameCdn(row, result.coalDeliveryNumber) || beforeCdn.has(row) || inTrip.has(row) ? 'cdn-match' : ''} ${isDeleted(row) ? 'deleted-record' : ''}`}>
            <div className="timeline-marker" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </div>
            <article className="transaction-card">
              <div className="transaction-title">
                <h3>
                  {value(transactionKind(row))}
                </h3>
                {['Kirim', 'Terima'].includes(transactionKind(row)) && actions(row)}
                <div className="transaction-badges">
                  <span className={`status ${sameCdn(row, result.coalDeliveryNumber) || beforeCdn.has(row) || inTrip.has(row) ? 'online' : 'unknown'}`}>
                    {sameCdn(row, result.coalDeliveryNumber) ? 'SK dicari' : beforeCdn.has(row) ? 'Ritase SK ini · sebelum SK terbit' : inTrip.has(row) ? 'Ritase SK ini · hingga Terima Kosong' : row.CoalDeliveryNumber ? 'SK lain' : 'SK tidak tercatat'}
                  </span>
                  {isDispatcherCreated(row) && <span className="status unknown" title="Penanda berdasarkan dtTimeCollected dengan milidetik 000, bukan audit pembuat.">{dispatcherLabel(row)}</span>}
                </div>
              </div>
              <DeletedStatus row={row} />
              <p className="transaction-meta">
                <strong>
                  {value(row.strEquipmentName)}
                </strong>
                <span>SK {value(row.CoalDeliveryNumber)}</span>
                <span className="mono">ID {value(row.CTFinalTonnageID)}</span>
                {['Kirim', 'Terima'].includes(transactionKind(row)) && <button type="button" className="transaction-icon-button" title="Cek relasi" disabled={promoting || releasing} onClick={() => setRelationRow(row)} aria-label={`Cek relasi ${transactionKind(row)} ${value(row.CTFinalTonnageID)}`}><ActionIcon action="inspect" /></button>}
                {transactionKind(row) === 'Kirim' && row.RefDumpingTonnageID == null && <button type="button" className="transaction-icon-button" hidden={!can('transactions.pair')} title="Pasangkan Terima" aria-busy={activeRow === Number(row.CTFinalTonnageID) && releasing} disabled={releasing || promoting || promotionNeedsReload || isDeleted(row)} onClick={() => void releaseRelation(row, true)} aria-label={`Pasangkan Terima untuk Kirim ${value(row.CTFinalTonnageID)}`}>
                  <ActionIcon action="link" />
                </button>}
                {transactionKind(row) === 'Kirim' && row.RefDumpingTonnageID !== null && row.RefDumpingTonnageID !== undefined && <>
                  <span>Ref: <strong>{value(row.RefDumpingTonnageID)}</strong></span>
                  <button type="button" className="transaction-icon-button" hidden={!can('transactions.unpair')} title="Lepas Relasi" aria-busy={activeRow === Number(row.CTFinalTonnageID) && releasing} disabled={releasing || promoting || promotionNeedsReload} onClick={() => void releaseRelation(row)} aria-label={`Lepas relasi Kirim ${value(row.CTFinalTonnageID)} dari Terima ${value(row.RefDumpingTonnageID)}`}>
                    <ActionIcon action="unlink" />
                  </button>
                </>}
              </p>
              <Details row={row} api={api} />
              {unpaired.has(row) && <p className="finding-warn"><strong>data tidak berpasangan otomatis</strong></p>}
              <div className="transaction-times">
                <span>Timbang kosong · dtEmpty<time>
                  {date(row.dtEmpty)}
                </time></span>
                <span>Timbang muat · dtLoaded<time>
                  {date(row.dtLoaded)}
                </time></span>
              </div>
            </article>
          </li>)}
            </ol>
          </section>)}
        </div> : <div className="empty">
          <h3>Transaksi tidak muncul dalam hasil procedure</h3>
          <p>MT, Net Reader, Check Point, atau Tol Gate hanya ditampilkan jika dikembalikan procedure. Aktivitas tanpa SK tidak otomatis dianggap milik SK dicari.</p>
        </div>}
      </section>
    </> : <div className="panel analysis-empty">
      <span className="section-index">COAL DELIVERY NUMBER</span>
      <h2>Telusuri perjalanan truck</h2>
      <p>Masukkan nomor SK untuk membaca transaksi Kirim / Terima, data TerimaRaw, dan aktivitas timbang, kirim, serta reader yang tercatat.</p>
    </div>}
  </div>;
}
