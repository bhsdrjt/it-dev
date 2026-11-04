import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { confirmAction } from './confirm-action';
import { Icon } from './Icon';

type JobStatus =
  | 'UPLOADED' | 'VALIDATING' | 'REJECTED' | 'READY' | 'QUEUED' | 'IMPORTING'
  | 'PREVIEW_STALE' | 'CANCELLING' | 'CANCELLED' | 'FAILED' | 'COMMITTED' | 'RECONCILIATION_REQUIRED';

type ImportJob = {
  id: string;
  packageId: string;
  target: string;
  status: JobStatus;
  revision: number;
  summary: ImportSummary | null;
  preview: ImportPreview | null;
  confirmError: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelled: boolean;
};

type ImportSummary = {
  packageId: string;
  formatVersion: string;
  exporterVersion: string;
  exportedAtUtc: string;
  source: string;
  userCount: number;
  fingerprintCount: number;
  cardCount: number;
  relationCount: number;
  usersWithoutCredential: number;
};

type PreviewUser = {
  sourceUsrUid: string;
  sourceUsrId: string;
  name: string | null;
  targetUsrId: string;
  status: 'Tetap' | 'Diganti' | 'Diblokir' | 'Dilewati';
  reason: string | null;
  fingerprintCount: number;
  csnCount: number;
};

type ImportPreview = {
  revision: number;
  users: PreviewUser[];
  changedCount: number;
  unchangedCount: number;
  credentialCount: { fingerprint: number; card: number; relation: number };
};

type ImportFingerprint = {
  sourceUsrUid: string;
  fngpIdx: number | null;
  dur: string | null;
  tml0: string | null;
  tml1: string | null;
  chs: string | null;
  lstmod: string | null;
};

type ImportCard = {
  sourceCrdUid: string;
  crdTypUid: number | null;
  crdCsn: string;
  asmUid: number | null;
  wgdfmUid: number | null;
  wgdfmTver: number | null;
};

type ImportRelation = {
  sourceUsrUid: string;
  sourceCrdUid: string;
  idx: number | null;
  issddt: string | null;
  expdt: string | null;
  issdcnt: number | null;
  crdmsk: number | null;
  prdstdt: string | null;
  prdeddt: string | null;
};

type Api = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

const statusLabel: Record<JobStatus, string> = {
  UPLOADED: 'Diunggah', VALIDATING: 'Memvalidasi', REJECTED: 'Ditolak', READY: 'Siap', QUEUED: 'Antrian',
  IMPORTING: 'Mengimpor', PREVIEW_STALE: 'Preview kadaluarsa', CANCELLING: 'Membatalkan', CANCELLED: 'Dibatalkan',
  FAILED: 'Gagal', COMMITTED: 'Disimpan', RECONCILIATION_REQUIRED: 'Perlu rekonsiliasi',
};

export function BiostarImport({ api }: { api: Api }) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmJob, setConfirmJob] = useState<ImportJob | null>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const historyDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!confirmOpen || !confirmJob || !confirmDialog.current) return;
    const dialog = confirmDialog.current;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [confirmOpen, confirmJob]);

  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const apiUpload = async (zip: File, packageId: string) => {
    const form = new FormData();
    form.append('zip', zip);
    form.append('packageId', packageId);
    const response = await fetch('/biostar/imports', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('token') || ''}` },
      body: form,
    });
    const data = await response.json().catch(() => ({ message: 'Respons server tidak valid.' }));
    if (!response.ok) throw Object.assign(new Error(typeof data.message === 'string' ? data.message : `Permintaan gagal (HTTP ${response.status}).`), { status: response.status });
    return data as { jobId: string; status: string; target: string };
  };

  const startPoll = useCallback(() => {
    if (polling.current) return;
    polling.current = setInterval(() => {
      void api<ImportJob[]>('/biostar/imports', 'GET').then(setJobs);
    }, 3000);
  }, [api]);
  const stopPoll = useCallback(() => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
  }, []);

  useEffect(() => {
    if (selectedId !== null) startPoll();
    return stopPoll;
  }, [selectedId, startPoll, stopPoll]);

  const load = useCallback(() => api<ImportJob[]>('/biostar/imports', 'GET').then(setJobs).catch(e => setError(e instanceof Error ? e.message : 'Gagal memuat riwayat impor.')), [api]);

  useEffect(() => { void load(); }, [load]);

  const accept = (mime: string) => mime === 'application/zip' || mime === 'application/x-zip-compressed';
  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0] ?? null;
    setFile(f);
    setFileName(f ? f.name : '');
    setError('');
  };

  const validateSize = (f: File) => {
    if (f.size > 100 * 1024 * 1024) throw new Error('ZIP melebihi batas upload 100 MB.');
  };

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) { setError('Pilih ZIP BioStar terlebih dahulu.'); return; }
    setBusy(true); setError('');
    try {
      validateSize(file);
      const result = await apiUpload(file, fileName.replace(/\.zip$/i, ''));
      setSelectedId(result.jobId);
      setConfirmOpen(false);
      setConfirmJob(null);
      void load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload gagal.'); }
    finally { setBusy(false); }
  };

  const job = selectedId ? jobs.find(j => j.id === selectedId) ?? null : null;
  const preview = job?.preview;
  const [detail, setDetail] = useState<{ fingerprints: any[]; cards: any[]; relations: any[] } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!detailOpen || !detail || !detailDialog.current) return;
    const dialog = detailDialog.current;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [detailOpen, detail]);

  const detailJobId = job?.id;
  const detailJobStatus = job?.status;
  const detailJobRevision = job?.revision;
  useEffect(() => {
    setDetailOpen(false);
    setDetail(null);
    setDetailBusy(false);
    if (!detailJobId || detailJobStatus !== 'READY') return;
    const controller = new AbortController();
    setDetailBusy(true);
    api<{ fingerprints: ImportFingerprint[]; cards: ImportCard[]; relations: ImportRelation[] }>(`/biostar/imports/${detailJobId}/detail`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setDetail(data); })
      .catch(() => { if (!controller.signal.aborted) setDetail(null); })
      .finally(() => { if (!controller.signal.aborted) setDetailBusy(false); });
    return () => controller.abort();
  }, [detailJobId, detailJobStatus, detailJobRevision, api]);

  const openConfirm = (j: ImportJob) => {
    if (!j.preview) { setError('Preview belum tersedia.'); return; }
    setConfirmJob(j); setConfirmOpen(true);
  };

  const doConfirm = async () => {
    if (!confirmJob) return;
    setBusy(true); setError('');
    try {
      const updated = await api<ImportJob>(`/biostar/imports/${confirmJob.id}/confirm`, 'POST', { revision: confirmJob.preview!.revision });
      setJobs(old => old.map(j => j.id === updated.id ? updated : j));
      setConfirmOpen(false); setConfirmJob(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Konfirmasi gagal.'); }
    finally { setBusy(false); }
  };

  const doCancel = async () => {
    if (!job) return;
    if (!await confirmAction(`Batalkan impor paket ${job.packageId}? Data yang belum disimpan akan dibatalkan.`)) return;
    setBusy(true); setError('');
    try {
      const updated = await api<ImportJob>(`/biostar/imports/${job.id}/cancel`, 'POST');
      setJobs(old => old.map(j => j.id === updated.id ? updated : j));
      setSelectedId(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Pembatalan gagal.'); }
    finally { setBusy(false); }
  };

  const doStart = async () => {
    if (!job) return;
    if (!await confirmAction(`Mulai impor paket ${job.packageId} ke ${job.target}? Seluruh data akan disimpan dalam satu transaksi.`)) return;
    setBusy(true); setError('');
    try {
      await api<void>(`/biostar/imports/${job.id}/start`, 'POST');
      void load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Memulai impor gagal.'); }
    finally { setBusy(false); }
  };

  const statusChip = (status: JobStatus) => {
    const cls = status === 'COMMITTED' ? 'status ok' : status === 'FAILED' || status === 'REJECTED' ? 'status err' : 'status info';
    return <span className={cls}>{statusLabel[status]}</span>;
  };

  return <div className="biostar-import-page menu-page">
    <div className="page-heading">
      <div>
        <h1>Import Data</h1>
      </div>
      <button type="button" className="icon-button" title="Riwayat pekerjaan" aria-label="Riwayat pekerjaan" aria-haspopup="dialog" onClick={() => { historyDialog.current?.showModal(); void load(); }}><Icon name="history" /></button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="biostar-card">
      <h2>Upload paket</h2>
      <form onSubmit={upload} className="biostar-form">
        <fieldset disabled={busy}>
          <label>Pilih ZIP<input type="file" accept=".zip" onChange={handleFile} disabled={busy} required /></label>
          <span className="helper">Satu ZIP dari BioStar ZIP Exporter. Maksimal 100 MB terkompresi. Template, key, PIN, dan nomor kartu lengkap tidak ditampilkan secara default.</span>
          <button className="primary" disabled={busy || !file}>
            {busy ? 'Mengunggah…' : 'Unggah dan validasi'}
          </button>
        </fieldset>
      </form>
    </section>

    {job && <section className="biostar-card">
      <h2>Ringkasan paket</h2>
      <div className="biostar-meta">
        <div><span>Paket</span><strong>{job.packageId}</strong></div>
        <div><span>Target</span><strong>{job.target}</strong></div>
        <div><span>Status</span>{statusChip(job.status)}</div>
        <div><span>Dibuat</span><strong>{new Date(job.createdAt).toLocaleString('id-ID')}</strong></div>
      </div>
      {job.summary && <div className="biostar-summary">
        <div><span>User</span><strong>{job.summary.userCount}</strong></div>
        <div><span>Fingerprint</span><strong>{job.summary.fingerprintCount}</strong></div>
        <div><span>Kartu CSN</span><strong>{job.summary.cardCount}</strong></div>
        <div><span>Relasi</span><strong>{job.summary.relationCount}</strong></div>
        <div><span>Tanpa credential</span><strong>{job.summary.usersWithoutCredential}</strong></div>
      </div>}
      {job.status === 'REJECTED' && <p className="error" role="alert">Paket ditolak karena masalah pemblokir. Perbaiki atau ekspor ulang.</p>}
      {job.status === 'QUEUED' && (
        <div className="biostar-actions">
          <button className="primary" disabled={busy} onClick={doStart}>Mulai impor</button>
          <button className="danger-text" disabled={busy} onClick={doCancel}>Batalkan</button>
        </div>
      )}
      {job.status === 'IMPORTING' && <p>Transaksi berjalan. Tidak dapat dibatalkan setelah commit dimulai.</p>}
      {(job.status === 'COMMITTED' || job.status === 'FAILED' || job.status === 'CANCELLED') && (
        <div className="biostar-actions">
          <button className="primary" disabled={busy} onClick={doCancel}>Tutup pekerjaan</button>
        </div>
      )}
    </section>}

    {preview && <section className="biostar-card">
      <h2>Preview user</h2>
      <p className="helper">Revisi {preview.revision}. {preview.changedCount} ID berubah, {preview.unchangedCount} tetap, {preview.users.filter(u => u.status === 'Dilewati').length} user dilewati. Nama sama persis (termasuk huruf besar/kecil dan spasi) di server tujuan tidak diimpor beserta credential-nya. Kartu bersama tetap diimpor untuk user yang lolos; konflik kartu yang akan diimpor memblokir seluruh impor.</p>
      {preview.changedCount + preview.unchangedCount === 0 && <p role="status">Tidak ada user baru untuk diimpor.</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>USRID sumber</th><th>Nama</th><th>USRID tujuan</th><th>Status</th><th>Alasan</th><th>Fingerprint</th><th>CSN</th></tr>
          </thead>
          <tbody>
            {preview.users.map(u => <tr key={u.sourceUsrUid}>
              <td className="mono">{u.sourceUsrId}</td>
              <td>{u.name ?? '—'}</td>
              <td className="mono">{u.targetUsrId || '—'}</td>
              <td>{u.status}</td>
              <td>{u.reason ?? '—'}</td>
              <td>{u.fingerprintCount}</td>
              <td>{u.csnCount}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="biostar-actions">
        {job?.status === 'READY' && <>
          <button className="primary" disabled={busy || preview.changedCount + preview.unchangedCount === 0} onClick={() => openConfirm(job)}>Setujui perubahan ID dan mapping</button>
          <button className="danger-text" disabled={busy} onClick={doCancel}>Batalkan</button>
        </>}
        {detail && <button disabled={busy} aria-haspopup="dialog" aria-controls="biostar-detail" onClick={() => setDetailOpen(true)}>Detail paket</button>}
      </div>
    </section>}

    {detail && detailOpen && <dialog id="biostar-detail" ref={detailDialog} className="biostar-detail-modal" aria-labelledby="biostar-detail-title" onCancel={() => setDetailOpen(false)} onClose={() => setDetailOpen(false)}>
      <div className="panel-heading">
        <h2 id="biostar-detail-title">Detail data paket</h2>
        <button type="button" className="icon-button" title="Tutup detail paket" aria-label="Tutup detail paket" onClick={() => setDetailOpen(false)}><Icon name="close" /></button>
      </div>
      <div className="biostar-detail-body">
      {detailBusy && <p>Memuat detail…</p>}
      <div className="biostar-subtable">
        <h3>Fingerprint ({detail.fingerprints.length})</h3>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Nama pemilik</th><th>Indeks</th><th>DUR</th><th>TMPL0</th><th>TMPL1</th><th>CHS</th><th>LSTMOD</th></tr></thead>
            <tbody>
              {detail.fingerprints.map(f => <tr key={`${f.sourceUsrUid}-${f.fngpIdx}`}>
                <td>{preview?.users.find(u => u.sourceUsrUid === f.sourceUsrUid)?.name || 'Nama tidak tersedia'}</td>
                <td>{f.fngpIdx ?? '—'}</td>
                <td>{f.dur ?? '—'}</td>
                <td className="mono">{f.tml0 ? `${f.tml0.length} char (Base64)` : '—'}</td>
                <td className="mono">{f.tml1 ? `${f.tml1.length} char (Base64)` : '—'}</td>
                <td>{f.chs ?? '—'}</td>
                <td>{f.lstmod ?? '—'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>
      <div className="biostar-subtable">
        <h3>Kartu CSN ({detail.cards.length})</h3>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Nama pemilik</th><th>Tipe</th><th>CSN</th><th>ASM</th><th>WGDFM</th><th>Versi</th></tr></thead>
            <tbody>
              {detail.cards.map(c => <tr key={c.sourceCrdUid}>
                <td>{detail.relations.filter(r => r.sourceCrdUid === c.sourceCrdUid).map(r => preview?.users.find(u => u.sourceUsrUid === r.sourceUsrUid)?.name || 'Nama tidak tersedia').join(', ') || 'Pemilik tidak tersedia'}</td>
                <td>{c.crdTypUid ?? '—'}</td>
                <td className="mono">{c.crdCsn}</td>
                <td>{c.asmUid ?? '—'}</td>
                <td>{c.wgdfmUid ?? '—'}</td>
                <td>{c.wgdfmTver ?? '—'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </dialog>}

    {confirmOpen && confirmJob && <dialog ref={confirmDialog} className="confirm-modal biostar-confirm" aria-labelledby="biostar-confirm-title" onCancel={() => setConfirmOpen(false)} onClose={() => setConfirmOpen(false)}>
      <form onSubmit={event => { event.preventDefault(); void doConfirm(); }}>
        <div className="panel-heading">
          <div>
            <span className="section-index">KONFIRMASI</span>
            <h2 id="biostar-confirm-title">Setujui impor paket</h2>
          </div>
          <button type="button" autoFocus onClick={() => setConfirmOpen(false)}>Tutup</button>
        </div>
        <div className="form-body">
          {error && <p className="error" role="alert">{error}</p>}
          <div className="biostar-meta">
            <div><span>Paket</span><strong>{confirmJob.packageId}</strong></div>
            <div><span>Target</span><strong>{confirmJob.target}</strong></div>
          </div>
          <p>{confirmJob.preview!.changedCount + confirmJob.preview!.unchangedCount} user akan diimpor, {confirmJob.preview!.users.filter(u => u.status === 'Dilewati').length} dilewati. {confirmJob.preview!.changedCount} ID berubah, {confirmJob.preview!.unchangedCount} tetap.</p>
          <p className="helper">Konfirmasi berarti Anda menyetujui target, revisi preview, jumlah ID berubah/tetap, mapping dependensi, jumlah credential, backup, dan maintenance.</p>
          <button className="primary wide" type="submit" disabled={busy}>{busy ? 'Menyetujui…' : 'Ya, setujui impor'}</button>
        </div>
      </form>
    </dialog>}

    <dialog ref={historyDialog} className="biostar-history" aria-labelledby="biostar-history-title">
      <div className="panel-heading">
        <h2 id="biostar-history-title">Riwayat pekerjaan</h2>
        <button type="button" autoFocus onClick={() => historyDialog.current?.close()}>Tutup</button>
      </div>
      <div className="form-body">
      <div className="table-scroll">
        <table>
          <thead><tr><th>Paket</th><th>Target</th><th>Status</th><th>Revisi</th><th>Dibuat</th><th>Aksi</th></tr></thead>
          <tbody>
            {jobs.slice(0, 50).map(j => <tr key={j.id}>
              <td className="mono">{j.packageId}</td>
              <td>{j.target}</td>
              <td>{statusChip(j.status)}</td>
              <td>{j.revision}</td>
              <td>{new Date(j.createdAt).toLocaleString('id-ID')}</td>
              <td>
                {j.id === selectedId && <span className="muted">Dipilih</span>}
                {j.id !== selectedId && <button onClick={() => { setSelectedId(j.id); historyDialog.current?.close(); }}>Pilih</button>}
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {jobs.length === 0 && <p className="muted">Belum ada pekerjaan impor.</p>}
      </div>
    </dialog>
  </div>;
}
