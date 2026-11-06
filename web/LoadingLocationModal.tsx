import { useEffect, useRef, useState } from 'react';
import { confirmAction } from './confirm-action';
import { date, value } from './TransactionCard';
import type { Row } from './transaction-analysis';
export type LoadingLocationPreview = { source: Row; candidate: Row; receipt?: Row | null; previewToken: string };
const fields = ['LoadingLocationID', 'strStockPileName', 'CoalQualityID', 'CoalCalory', 'strCoalQualityName'];
export function LoadingLocationModal({ row, api, close, save, busy }: {
  row: Row;
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  close: () => void;
  save: (preview: LoadingLocationPreview) => Promise<void>;
  busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<LoadingLocationPreview | null>(null);
  const [error, setError] = useState('');
  const blocked = busy || confirming;
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    const controller = new AbortController();
    element?.showModal();
    void api<LoadingLocationPreview>(`/transactions/loading-location?loadingTonnageId=${encodeURIComponent(String(row.CTFinalTonnageID))}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setPreview(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Kandidat lokasi gagal dimuat.'); });
    return () => { controller.abort(); element?.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, [api, row]);
  return <dialog ref={dialog} className="relation-modal loading-location-modal" aria-labelledby="loading-location-title" onCancel={event => { event.preventDefault(); if (!blocked) close(); }}>
    <div className="panel-heading"><h2 id="loading-location-title">Get LoadingLocation · Kirim #{value(row.CTFinalTonnageID)}</h2><button type="button" autoFocus disabled={blocked} onClick={close}>Tutup</button></div>
    <div className="relation-modal-body">
      {error ? <p className="error" role="alert">{error}</p> : !preview ? <p role="status" aria-busy="true">Mencari reader terbaru dalam rentang timbang Kirim…</p> : <>
        <p>SK <strong>{value(preview.source.CoalDeliveryNumber)}</strong> · EquipmentID {value(preview.source.EquipmentID)}<br />Rentang {date(preview.source.dtEmpty)} – {date(preview.source.dtLoaded)}<br />Waktu reader {date(preview.candidate.readerAt)}</p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Preview Get LoadingLocation"><table><thead><tr><th scope="col">Kolom</th><th scope="col">Nilai lama</th><th scope="col">Nilai baru</th></tr></thead><tbody>{fields.map(field => <tr key={field}><th scope="row">{field}</th><td>{value(preview.source[field])}</td><td>{value(preview.candidate[field])}</td></tr>)}</tbody></table></div>
        {preview.receipt ? <>
          <h3>Pasangan Terima #{value(preview.receipt.CTFinalDumpingTonnageID)} · SK {value(preview.receipt.CoalDeliveryNumber)}</h3>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Preview pasangan Terima"><table><thead><tr><th scope="col">Kolom</th><th scope="col">Nilai lama Terima</th><th scope="col">Nilai baru</th></tr></thead><tbody>{fields.map(field => <tr key={field}><th scope="row">{field}</th><td>{value(preview.receipt![field])}</td><td>{value(preview.candidate[field])}</td></tr>)}</tbody></table></div>
        </> : <p className="helper">Tanpa referensi pasangan Terima. Hanya Kirim diperbarui.</p>}
        <p className="helper">Lima kolom Kirim dan pasangan Terima diperbarui dalam satu transaksi beserta audit. Jika sumber, pasangan, atau kandidat berubah sejak preview, penyimpanan ditolak.</p>
        <button type="button" className="primary" disabled={blocked} aria-busy={busy} onClick={async () => {
          if (submitting.current) return;
          submitting.current = true; setConfirming(true);
          try {
            if (await confirmAction(`Simpan Get LoadingLocation untuk Kirim #${value(row.CTFinalTonnageID)}, SK ${value(preview.source.CoalDeliveryNumber)}?\n\nPerbarui LoadingLocationID, strStockPileName, CoalQualityID, CoalCalory, dan strCoalQualityName sesuai preview.${preview.receipt ? ` Pasangan Terima #${value(preview.receipt.CTFinalDumpingTonnageID)}, SK ${value(preview.receipt.CoalDeliveryNumber)}, ikut diperbarui.` : ' Tanpa pasangan Terima; hanya Kirim diperbarui.'} Jika salah satu gagal, seluruh perubahan dibatalkan. Efek trigger DB tetap berlaku. Lanjutkan?`)) await save(preview);
          } finally { submitting.current = false; setConfirming(false); }
        }}>{busy ? 'Menyimpan…' : 'Simpan Get LoadingLocation'}</button>
      </>}
    </div>
  </dialog>;
}
