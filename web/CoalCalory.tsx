import { usePermissions } from './permissions';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { confirmAction } from './confirm-action';
import { SkeletonPanel } from './SkeletonPanel';
import { Icon } from './Icon';

export type CoalCaloryRow = {
  CoalQualityAGMID: number;
  CoalQualityID: number;
  CoalQualityName: string | null;
  Coalcalory: number | null;
  dtUpdatedAt: string | null;
};
type Props = {
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  log: (level: 'ok' | 'err' | 'info', message: string, note?: string) => void;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Terjadi kesalahan.';
const time = (value: string | null) => value ? value.replace('T', ' ').replace(/Z$/, '') : '—';

/** Baris CSV: CoalQualityName,Coalcalory — dipisah koma/tab/koma-panjang, baris kosong dilewati. */
export function parseCoalCaloryImport(text: string): { name: string; calory: string }[] {
  const items: { name: string; calory: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawName = '', rawCalory = ''] = line.split(/[,\t;]/).map(cell => cell.trim().replace(/^"|"$/g, ''));
    items.push({ name: rawName, calory: rawCalory });
  }
  // Baris pertama judul kolom.
  if (items.length && /^coalqualityname$/i.test(items[0].name) && /^coalcalory$/i.test(items[0].calory)) items.shift();
  return items.filter(item => item.name !== '' || item.calory !== '');
}

/** Menu Coal Calory: kelola data tabCoalQualityAGM (edit dan hapus saja, tanpa tambah). */
export function CoalCalory({ api, log }: Props) {
  const can = usePermissions();
  const hasActions = can('coal.update') || can('coal.delete');
  const [rows, setRows] = useState<CoalCaloryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [coalLoading, setCoalLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CoalCaloryRow | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'CoalQualityAGMID', direction: 'asc' });
  const [importPlan, setImportPlan] = useState<{ fileName: string; items: { name: string; calory: string }[] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const pending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setCoalLoading(true);
    setError('');
    try {
      const data = await api<CoalCaloryRow[]>('/coal-calories');
      setRows(data);
      log('ok', `${data.length} data Coal Calory dimuat.`);
    } catch (cause) {
      setError(message(cause));
      log('err', message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      setCoalLoading(false);
    }
  }, [api, log]);
  useEffect(() => { void load(); }, [load]);

  async function remove(row: CoalCaloryRow) {
    if (pending.current) return;
    if (!await confirmAction(`Hapus Coal Calory #${row.CoalQualityAGMID} (${row.CoalQualityName ?? 'tanpa nama'})?\n\nData ditandai dihapus dengan dtDeletedAt = GETDATE(), bukan dihapus permanen; trigger dapat menyalin status ini ke tabEnum. Lanjutkan?`)) {
      log('info', 'Penghapusan Coal Calory dibatalkan.');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ message: string }>(`/coal-calories/${row.CoalQualityAGMID}`, 'DELETE', { confirmed: true });
      setRows(old => old.filter(item => item.CoalQualityAGMID !== row.CoalQualityAGMID));
      log('ok', result.message);
    } catch (cause) {
      setError(message(cause));
      log('err', message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      setCoalLoading(false);
    }
  }

  const query = search.trim().toLowerCase();
  // Pencarian lokal di hasil aktif; memuat ulang tetap membaca ulang database.
  const visible = rows.filter(row => `${row.CoalQualityAGMID} ${row.CoalQualityID} ${row.CoalQualityName ?? ''}`.toLowerCase().includes(query));
  const sorted = useMemo(() => {
    const direction = sort.direction === 'asc' ? 1 : -1;
    // Nilai null selalu di bawah; ID sebagai tiebreak agar urutan stabil.
    return [...visible].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      if (left == null && right == null) return a.CoalQualityAGMID - b.CoalQualityAGMID;
      if (left == null) return 1;
      if (right == null) return -1;
      const result = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'id', { numeric: true, sensitivity: 'base' });
      return result === 0 ? a.CoalQualityAGMID - b.CoalQualityAGMID : result * direction;
    });
  }, [visible, sort]);
  const toggleSort = (key: SortKey) => setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const header = (key: SortKey, label: string) => <th aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className="sort-header" title={`Urutkan ${label}`} onClick={() => toggleSort(key)}>
      {label}<span aria-hidden="true">{sort.key === key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</span>
    </button>
  </th>;

  return <>
    {coalLoading && <SkeletonPanel title="Coal calory" subtitle="Membaca data tabCoalQualityAGM." rows={4} />}
    {!coalLoading && (
    <>
    <div className="page-heading">
      <div>
        <h1 id="coal-calory-title">Coal calory</h1>
      </div>
      <div className="heading-actions">
        <span>Baris aktif <strong className="mono">{String(rows.length).padStart(2, '0')}</strong></span>
        <button className="icon-button" title="Muat ulang" aria-label="Muat ulang" aria-busy={busy} onClick={() => void load()} disabled={busy}><Icon name="reload" /></button>
      </div>
    </div>
    {error && <div className="error-banner" role="alert">
      <span>{error}</span>
      <button onClick={() => void load()} disabled={busy}>Coba lagi</button>
    </div>}
    <section className="panel registry coal-calory-panel" aria-label="Data Coal Calory">
      <div className="panel-heading">
        <div>
          <span className="section-index">01 / COAL CALORY</span>
          <h2>Data kualitas batu bara <span className="count">{rows.length}</span></h2>
        </div>
        <span className="small-tag" hidden={!hasActions}>{[can('coal.update') && 'EDIT', can('coal.delete') && 'HAPUS'].filter(Boolean).join(' / ')}</span>
      </div>
      <div className="panel-toolbar">
        <label className="search-label">Cari data<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="ID, CoalQualityID, atau nama kualitas" disabled={busy} autoComplete="off" /></label>
        <button type="button" className="icon-button" hidden={!can('coal.import')} title="Impor CSV" aria-label="Impor CSV" onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="upload" /></button>
        <button type="button" className="icon-button" hidden={!can('coal.export')} title="Ekspor CSV" aria-label="Ekspor CSV" onClick={() => setExporting(true)} disabled={busy || !rows.length}><Icon name="download" /></button>
        {/* ponytail: parser lokal tanpa library; bila perlu quote/koma di dalam nama, pakai parser CSV khusus. */}
        <input ref={fileInput} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void file.text().then(text => {
            const items = parseCoalCaloryImport(text);
            if (!items.length) { setError('File tidak berisi baris data. Format: CoalQualityName,Coalcalory per baris.'); log('err', `Impor ${file.name} gagal: tidak ada baris data.`); return; }
            setImportPlan({ fileName: file.name, items });
            log('info', `File ${file.name} dibaca: ${items.length} baris.`);
          });
        }} />
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {header('CoalQualityAGMID', 'ID')}
              {header('CoalQualityID', 'CoalQualityID')}
              {header('CoalQualityName', 'CoalQualityName')}
              {header('Coalcalory', 'Coalcalory')}
              {header('dtUpdatedAt', 'Diperbarui')}
              <th hidden={!hasActions}><span className="sr-only">Aksi</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => <tr key={row.CoalQualityAGMID}>
              <td className="mono">#{row.CoalQualityAGMID}</td>
              <td className="mono">{row.CoalQualityID}</td>
              <td>{row.CoalQualityName || <span className="muted">—</span>}</td>
              <td className="mono">{row.Coalcalory ?? <span className="muted">belum diisi</span>}</td>
              <td className="mono">{time(row.dtUpdatedAt)}</td>
              <td hidden={!hasActions}>
                <div className="row-actions">
                  <button className="transaction-icon-button" hidden={!can('coal.update')} title={`Edit Coal Calory ${row.CoalQualityAGMID}`} onClick={() => { setEditing(row); log('info', `Edit Coal Calory #${row.CoalQualityAGMID}.`); }} disabled={busy} aria-label={`Edit Coal Calory ${row.CoalQualityAGMID}`}><Icon name="edit" /></button>
                  <button className="transaction-icon-button danger-text" hidden={!can('coal.delete')} title={`Hapus Coal Calory ${row.CoalQualityAGMID}`} onClick={() => void remove(row)} disabled={busy} aria-label={`Hapus Coal Calory ${row.CoalQualityAGMID}`}><Icon name="trash" /></button>
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {!sorted.length && <div className="empty">
        <span className="empty-number">{busy ? '…' : '00'}</span>
        <h3>{busy ? 'Memuat data Coal Calory' : rows.length ? 'Data tidak ditemukan' : 'Belum ada data'}</h3>
        <p>{busy ? 'Membaca tabCoalQualityAGM.' : rows.length ? 'Coba kata pencarian lain.' : 'Data Coal Calory aktif belum tersedia.'}</p>
      </div>}
      <footer className="panel-footer">{sorted.length} baris aktif ditampilkan <span>Hapus menyetel dtDeletedAt, bukan menghapus permanen</span></footer>
    </section>
    {editing && <CoalCaloryEditor row={editing} api={api} log={log} close={() => setEditing(null)} saved={() => {
      setEditing(null);
      // Ambil ulang agar dtUpdatedAt berasal dari database, bukan jam browser.
      void load();
    }} />}
    {importPlan && <CoalCaloryImport plan={importPlan} rows={rows} api={api} log={log} close={() => setImportPlan(null)} done={() => {
      setImportPlan(null);
      // Ambil ulang agar dtUpdatedAt berasal dari database, bukan jam browser.
      void load();
    }} />}
    {exporting && <CoalCaloryExport rows={rows} log={log} close={() => setExporting(false)} />}
    </>
  )}
  </>;
}

type ImportItem = { name: string; calory: string };
export type ExportScope = 'all' | 'empty' | 'filled';

/** CSV ekspor: hanya CoalQualityName dan Coalcalory; nama dikutip bila mengandung pemisah. */
export function buildCoalCaloryExport(rows: CoalCaloryRow[], scope: ExportScope) {
  const cell = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const picked = rows.filter(row => scope === 'all' || (scope === 'empty' ? row.Coalcalory == null : row.Coalcalory != null));
  const lines = ['CoalQualityName,Coalcalory'];
  for (const row of picked) lines.push(`${cell(row.CoalQualityName ?? '')},${row.Coalcalory ?? ''}`);
  return { text: lines.join('\r\n') + '\r\n', count: picked.length };
}
type SortKey = 'CoalQualityAGMID' | 'CoalQualityID' | 'CoalQualityName' | 'Coalcalory' | 'dtUpdatedAt';

/** Jarak edit sederhana untuk menyarankan nama mirip saat nama tidak ditemukan. */
function distance(a: string, b: string) {
  const rows = a.length + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Cocokkan CSV ke baris aktif by CoalQualityName; hanya baris cocok yang di-PUT, tanpa insert. */
function planImport(items: ImportItem[], rows: CoalCaloryRow[]) {
  const byName = new Map(rows.filter(row => row.CoalQualityName?.trim()).map(row => [row.CoalQualityName!.trim().toLowerCase(), row]));
  const matched: { row: CoalCaloryRow; name: string; calory: number | null }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const row = byName.get(key);
    if (!row) {
      // ponytail: saran dua nama terdekat; ganti ke pencarian fuzzy penuh jika daftar nama sangat besar.
      const suggestion = [...byName.values()]
        .map(candidate => ({ name: candidate.CoalQualityName!.trim(), score: distance(key, candidate.CoalQualityName!.trim().toLowerCase()) }))
        .sort((a, b) => a.score - b.score)[0];
      const hint = suggestion && suggestion.score <= Math.max(2, Math.round(key.length / 5)) ? `, mirip: ${suggestion.name}` : '';
      skipped.push(`tidak ditemukan: ${item.name || '(kosong)'}${hint}`);
      continue;
    }
    if (seen.has(key)) { skipped.push(`duplikat: ${item.name}`); continue; }
    if (!/^\d+$/.test(item.calory)) { skipped.push(`calory tidak valid: ${item.name} = ${item.calory || '(kosong)'}`); continue; }
    const calory = Number(item.calory);
    if (calory > 2147483647) { skipped.push(`calory > 2147483647: ${item.name}`); continue; }
    seen.add(key);
    matched.push({ row, name: row.CoalQualityName!, calory });
  }
  return { matched, skipped };
}

function CoalCaloryImport({ plan, rows, api, log, close, done }: {
  plan: { fileName: string; items: ImportItem[] };
  rows: CoalCaloryRow[];
  api: Props['api'];
  log: Props['log'];
  close: () => void;
  done: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const { matched, skipped } = planImport(plan.items, rows);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const cancel = () => {
    if (!running.current) {
      log('info', 'Impor Coal Calory dibatalkan.');
      close();
    }
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    if (!matched.length) { setError('Tidak ada baris yang cocok untuk diperbarui.'); return; }
    if (!await confirmAction(`Perbarui Coalcalory ${matched.length} baris dari ${plan.fileName}?\n\nBaris cocok di-PUT satu per satu (edit, tanpa insert). Baris dilewati tidak diubah. Lanjutkan?`)) {
      log('info', 'Impor Coal Calory dibatalkan.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    let updated = 0;
    const failures: string[] = [];
    try {
      for (const item of matched) {
        try {
          await api<{ message: string }>(`/coal-calories/${item.row.CoalQualityAGMID}/import`, 'PUT', { coalQualityName: item.name, coalcalory: item.calory });
          updated++;
        } catch (cause) {
          failures.push(`${item.name}: ${message(cause)}`);
        }
      }
      const note = failures.length ? failures.join('; ') : undefined;
      log(failures.length ? 'err' : 'ok', `Impor ${plan.fileName}: ${updated} baris diperbarui, ${skipped.length + failures.length} dilewati.`, note);
      if (failures.length && !updated) { setError(note ?? 'Semua baris gagal diperbarui.'); running.current = false; setBusy(false); return; }
      done();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return <dialog ref={dialog} aria-labelledby="coal-calory-import-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <span className="section-index">COAL CALORY</span>
          <h2 id="coal-calory-import-title">Impor CSV</h2>
        </div>
        <button type="button" onClick={cancel} disabled={busy}>Tutup</button>
      </div>
      <div className="form-body">
        <span className="helper mono">{plan.fileName} · {plan.items.length} baris · format CoalQualityName,Coalcalory</span>
        <label>Baris cocok — akan diperbarui ({matched.length})
          <div className="import-preview">{matched.length ? matched.map(item => <span key={item.row.CoalQualityAGMID} className="mono">#{item.row.CoalQualityAGMID} {item.name} → {item.calory}</span>) : <span className="muted">Tidak ada</span>}</div>
        </label>
        <label>Baris ditolak — tidak diubah ({skipped.length})
          <div className="import-preview">{skipped.length ? skipped.map((item, index) => <span key={index} className="mono">{index + 1}. {item}</span>) : <span className="muted">Tidak ada — semua baris diterima</span>}</div>
        </label>
        <span className="helper">Kecocokan memakai CoalQualityName aktif tanpa membedakan huruf besar/kecil. Baris nama tidak ditemukan, duplikat, atau calory tidak valid dilewati; tanpa insert baru.</span>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary wide" aria-busy={busy} disabled={busy || !matched.length}>
          {busy ? 'Memperbarui…' : `Terapkan ${matched.length} baris`}
        </button>
      </div>
    </form>
  </dialog>;
}

/** Ekspor 2 kolom tanpa request tambahan. coal.export membatasi UI; pengguna coal.view tetap dapat menyalin data yang sudah dibaca. */
function CoalCaloryExport({ rows, log, close }: {
  rows: CoalCaloryRow[];
  log: Props['log'];
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<ExportScope>('all');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const empty = rows.filter(row => row.Coalcalory == null).length;
  const filled = rows.length - empty;
  const { count } = buildCoalCaloryExport(rows, scope);
  const options: { value: ExportScope; label: string; total: number }[] = [
    { value: 'all', label: 'Semua data', total: rows.length },
    { value: 'empty', label: 'Hanya Coalcalory kosong', total: empty },
    { value: 'filled', label: 'Hanya Coalcalory terisi', total: filled },
  ];
  function download() {
    const { text, count: total } = buildCoalCaloryExport(rows, scope);
    const date = new Date();
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `coal-calory-${scope}-${stamp}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    log('ok', `Ekspor ${total} baris Coal Calory (${options.find(option => option.value === scope)!.label}).`);
    close();
  }
  return <dialog ref={dialog} aria-labelledby="coal-calory-export-title" onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => { event.preventDefault(); download(); }}>
      <div className="panel-heading">
        <div>
          <span className="section-index">COAL CALORY</span>
          <h2 id="coal-calory-export-title">Ekspor CSV</h2>
        </div>
        <button type="button" onClick={close}>Tutup</button>
      </div>
      <div className="form-body">
        {options.map(option => <label className="check-label" key={option.value}>
          <input type="radio" name="coal-calory-export-scope" value={option.value} checked={scope === option.value} onChange={() => setScope(option.value)} />
          <span>{option.label}<small>{option.total} baris</small></span>
        </label>)}
        <span className="helper">File berisi kolom CoalQualityName dan Coalcalory, format CSV siap diimpor kembali.</span>
        <button className="primary wide" disabled={!count}>{count ? `Ekspor ${count} baris` : 'Tidak ada baris'}</button>
      </div>
    </form>
  </dialog>;
}

function CoalCaloryEditor({ row, api, log, close, saved }: {
  row: CoalCaloryRow;
  api: Props['api'];
  log: Props['log'];
  close: () => void;
  saved: (row: CoalCaloryRow) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(row.CoalQualityName ?? '');
  const [calory, setCalory] = useState(row.Coalcalory == null ? '' : String(row.Coalcalory));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const cancel = () => {
    if (!saving.current) {
      log('info', 'Formulir Coal Calory ditutup tanpa menyimpan.');
      close();
    }
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    // Kosong berarti kalori dihapus (null); selain itu wajib integer.
    const trimmed = calory.trim();
    if (trimmed !== '' && !/^\d+$/.test(trimmed)) { setError('Coalcalory harus bilangan bulat positif atau dikosongkan.'); return; }
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && value > 2147483647) { setError('Coalcalory maksimal 2147483647.'); return; }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ message: string }>(`/coal-calories/${row.CoalQualityAGMID}`, 'PUT', { coalQualityName: name, coalcalory: value });
      log('ok', result.message);
      saved(row);
    } catch (cause) {
      setError(message(cause));
      log('err', message(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return <dialog ref={dialog} aria-labelledby="coal-calory-editor-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <span className="section-index">COAL CALORY</span>
          <h2 id="coal-calory-editor-title">Edit Coal Calory #{row.CoalQualityAGMID}</h2>
        </div>
        <button type="button" onClick={cancel} disabled={busy}>Tutup</button>
      </div>
      <div className="form-body">
        <label>CoalQualityName<input autoFocus required maxLength={255} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="Contoh: SEAM TC-SMU" /></label>
        <label>Coalcalory<input inputMode="numeric" value={calory} onChange={event => setCalory(event.target.value)} disabled={busy} placeholder="Kosongkan untuk null" /><span className="helper">Bilangan bulat 0–2147483647; kosongkan untuk mengosongkan nilai.</span></label>
        <span className="helper mono">CoalQualityID {row.CoalQualityID} · Diperbarui {time(row.dtUpdatedAt)}</span>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary wide" aria-busy={busy} disabled={busy}>
          {busy ? 'Menyimpan…' : 'Simpan perubahan'}
        </button>
      </div>
    </form>
  </dialog>;
}
