import { useEffect, useId, useRef, useState } from 'react';
import { transactionKind, type Row } from './transaction-analysis';
export const value = (item: Row[string] | undefined) => item === null || item === undefined || item === '' ? '—' : String(item);
// SQL datetime tidak menyimpan zona waktu. Tampilkan jam database tanpa pergeseran browser.
export const date = (item: Row[string] | undefined) => typeof item === 'string' ? item.replace('T', ' ').replace(/Z$/, '') : value(item);
export const cell = (key: string, item: Row[string]) => key.startsWith('dt') ? date(item) : value(item);
export function ActionIcon({ action }: { action: 'receive' | 'unlink' | 'link' | 'inspect' | 'columns' }) {
  const paths = {
    inspect: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    receive: 'M12 3v12m-4-4 4 4 4-4M4 14v6h16v-6',
    unlink: 'm3 3 18 18M9 15l6-6M6 12l-2 2a4 4 0 0 0 6 6l2-2M12 6l2-2a4 4 0 0 1 6 6l-2 2',
    link: 'm9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    columns: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[action]} /></svg>;
}
type DetailApi = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const detailGroup = (key: string) => /^dt/i.test(key) ? 'Waktu' : /tonnage|weight/i.test(key) && !/id$/i.test(key) ? 'Tonase' : /location|stockpile|coal|calory/i.test(key) && key !== 'CoalDeliveryNumber' ? 'Lokasi & kualitas' : /^(is|status)/i.test(key) ? 'Status' : /id$|name$|number$|truck/i.test(key) ? 'Identitas & referensi' : 'Kolom lainnya';
export function Details({ row, api }: {
  row: Row; api?: DetailApi
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const pending = useRef<AbortController | null>(null);
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => () => pending.current?.abort(), []);
  async function load() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setData(null); setError(''); setFilter('');
    try {
      if (!api) throw new Error('Layanan detail tidak tersedia.');
      const result = await api<Row>(`/transactions/detail?kind=${encodeURIComponent(transactionKind(row))}&tonnageId=${encodeURIComponent(String(row.CTFinalTonnageID))}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Detail gagal dimuat.');
    }
  }
  const columns = <dl>
      {Object.entries(row).map(([key, item]) => <div key={key}>
        <dt>
          {key}
        </dt>
        <dd>
          {cell(key, item)}
        </dd>
      </div>)}
    </dl>;
  const kind = transactionKind(row);
  if (['Kirim', 'Terima'].includes(kind)) return <div className="transaction-details column-details">
    <button ref={trigger} type="button" className="transaction-icon-button" aria-label="Detail seluruh kolom" title="Detail seluruh kolom" aria-haspopup="dialog" onClick={() => { trigger.current?.focus(); dialog.current?.showModal(); void load(); }}><ActionIcon action="columns" /></button>
    <dialog ref={dialog} className="relation-modal transaction-detail-modal" aria-labelledby={titleId} onCancel={() => pending.current?.abort()}>
      <div className="panel-heading"><div><h2 id={titleId}>Detail {kind} · #{value(row.CTFinalTonnageID)}</h2><p className="helper">{kind === 'Kirim' ? 'tabCTFinalLoadingTonnage' : 'tabCTFinalDumpingTonnage'} · Data terbaru saat dibuka</p></div><button type="button" autoFocus onClick={() => { pending.current?.abort(); dialog.current?.close(); }}>Tutup</button></div>
      <div className="relation-modal-body">
        {error ? <div role="alert"><p className="error">{error}</p><button type="button" onClick={() => void load()}>Coba lagi</button></div> : !data ? <p role="status" aria-busy="true">Memuat detail dari database…</p> : <>
          <div className="detail-overview"><div><span>Nomor SK</span><strong>{value(data.CoalDeliveryNumber)}</strong></div><div><span>EquipmentID</span><strong>{value(data.EquipmentID)}</strong></div><div><span>Status data</span><strong>{data.dtDeletedAt == null ? 'Aktif' : 'Sudah dihapus'}</strong></div></div>
          <label className="detail-search">Cari kolom atau nilai<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Contoh: dtLoaded, tonnage, lokasi" /></label>
          {['Identitas & referensi', 'Waktu', 'Tonase', 'Lokasi & kualitas', 'Status', 'Kolom lainnya'].map(group => {
            const entries = Object.entries(data).filter(([key, item]) => detailGroup(key) === group && `${key} ${item}`.toLowerCase().includes(filter.toLowerCase()));
            return entries.length > 0 && <section className="detail-section" key={group}><h3>{group}<span>{entries.length} kolom</span></h3><dl>{entries.map(([key, item]) => <div key={key}><dt>{key}</dt><dd className={item === null ? 'detail-null' : undefined}>{item === null ? 'NULL' : item === '' ? '(teks kosong)' : cell(key, item)}</dd></div>)}</dl></section>;
          })}
          {!Object.entries(data).some(([key, item]) => `${key} ${item}`.toLowerCase().includes(filter.toLowerCase())) && <p role="status">Kolom atau nilai tidak ditemukan.</p>}
        </>}
      </div>
    </dialog>
  </div>;
  return <details className="transaction-details column-details">
    <summary className="transaction-icon-button" aria-label="Detail seluruh kolom" title="Detail seluruh kolom"><ActionIcon action="columns" /></summary>
    {columns}
  </details>;
}
