import { BiostarImport } from './BiostarImport';
import { AccessManagement } from './AccessManagement';
import { PermissionsContext, pagePermissions } from './permissions';
import { UserAudit } from './UserAudit';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './design-tokens.css';
import { Combobox } from './Combobox';
import { Transactions } from './Transactions';
import { TruckHistory } from './TruckHistory';
import { AnomalyDashboard } from './AnomalyDashboard';
import { CoalCalory } from './CoalCalory';
import { ThemeToggle } from './ThemeToggle';
import { LoginBackground } from './LoginBackground';
import { confirmAction } from './confirm-action';
import { Icon } from './Icon';
type Pc = {
  id: string;
  apiName: string;
  ipAPI: string;
  locationIDs: number[];
  online?: boolean;
  latency?: number | null;
  method?: string | null
};
type Equipment = {
  EquipmentID: number;
  strTruckCN: string
};
type Location = {
  LocationID: number;
  strLocationName: string
};
type Entry = {
  id: number;
  time: string;
  level: 'ok' | 'err' | 'info';
  message: string;
  note?: string
};
type RequestApi = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : 'Terjadi kesalahan.';
const pcLabel = (pc: Pc) => `${pc.apiName} (${pc.ipAPI})`;
const menuIcons = {
  equipment: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-2.1z',
  transactions: 'M4 20V10M10 20V4M16 20v-7M3 20h18',
  anomalies: 'M2 12h4l3-7 4 14 3-7h6',
  activity: 'M3 7V3m0 4h4M3.6 7a9 9 0 1 1-.6 8M12 7v5l3 2',
  access: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-2a6 6 0 0 1 10-4.5M15 16v-2a2 2 0 0 1 4 0v2m-5 0h6v5h-6z',
  audit: 'M14 21H5V3h10l4 4v5M14 3v5h5M8 11h5M8 15h3M19 16a3 3 0 1 0-6 0 3 3 0 0 0 6 0m-1 2 3 3',
  history: 'M3 16V7a1 1 0 0 1 1-1h9v10H3zm10 0h4l3 3v-3h1a1 1 0 0 0 0-2h-1v-3M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  calory: 'M12 3c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4 0 1.5.8 2.2 1.6 2.5C11.2 7.5 11.4 5 12 3z',
  import: 'M12 3v12m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
} as const;
function MenuIcon({ name }: { name: keyof typeof menuIcons }) {
  return <svg className="sidebar-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={menuIcons[name]} /></svg>;
}
function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('token') || '');
  const [profile, setProfile] = useState<{ username: string; displayName?: string; roles?: string[]; permissions: string[] } | null>(null);
  const [profileError, setProfileError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const log = useCallback((level: Entry['level'], message: string, note?: string) => {
    setEntries(rows => [...rows, { id: ++sequence.current, time: new Date().toLocaleTimeString('id-ID'), level, message, note }]);
  }, []);
  const logout = useCallback(() => {
    sessionStorage.removeItem('token');
    setToken('');
    setProfile(null);
    setEntries([]);
  }, []);
  // Satu jalur request berautentikasi; HTTP 401 menghapus sesi lokal.
  const api: RequestApi = useCallback(async <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(path, {
      method,
      signal: path.startsWith('/transactions/') ? AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]) : signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ message: 'Respons server tidak valid.' }));
    // Setiap eksekusi DB mengembalikan query yang berjalan; masukkan ke Activity Log sesi.
    const queries: string[] = Array.isArray(data?.queries) ? data.queries.filter((query: unknown): query is string => typeof query === 'string') : [];
    queries.forEach(query => log('info', 'Query dieksekusi.', query));
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        setLoginError('Sesi berakhir. Silakan login kembali.');
      }
      throw Object.assign(new Error(typeof data.message === 'string' ? data.message : `Permintaan gagal (HTTP ${response.status}).`), { status: response.status, queries });
    }
    return data as T;
  }, [token, logout, log]);
  useEffect(() => {
    setProfile(null);
    setProfileError('');
    if (!token) return;
    const controller = new AbortController();
    api<{ username: string; displayName?: string; roles?: string[]; permissions: string[]; user?: { username: string; displayName?: string; roles?: string[]; permissions: string[] } }>('/auth/me', 'GET', undefined, controller.signal)
      .then(data => {
        const user = data.user ?? data;
        if (!Array.isArray(user.permissions) || !user.permissions.every(code => typeof code === 'string')) throw new Error('Profil izin tidak valid.');
        if (user.roles !== undefined && (!Array.isArray(user.roles) || !user.roles.every(role => typeof role === 'string'))) throw new Error('Profil role tidak valid.');
        if (!controller.signal.aborted) setProfile(user);
      }).catch(error => { if (!controller.signal.aborted) setProfileError(message(error)); });
    return () => controller.abort();
  }, [token, api]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setLoginError('');
    try {
      const response = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Login gagal.');
      sessionStorage.setItem('token', data.token);
      setToken(data.token);
      log('ok', 'Login berhasil.');
    } catch (error) {
      setLoginError(message(error));
      log('err', message(error));
    }
    finally {
      setBusy(false);
    }
  }
  if (!token) return <main className="login-layout">
    <LoginBackground />
    <section className="login-card">
      <div className="brand"><span className="brand-mark">IT</span> DEV OPS</div>
      <h2>Masuk ke workspace</h2>
      <p>Gunakan akun individual IT Dev Ops.</p>
      <ThemeToggle />
      <form onSubmit={login} className="login-form">
        <label>Username<input name="username" autoComplete="username" required maxLength={200} autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={1000} /></label>
        {loginError && <p className="error" role="alert">
          {loginError}
        </p>}
        <button className="primary wide" disabled={busy}>
          {busy ? 'Memeriksa akun…' : 'Masuk workspace'}
        </button>
        <p className="footnote">Sesi berlaku 12 jam. Hanya untuk user berwenang.</p>
      </form>
    </section>
  </main>;
  if (!profile) return <main className="login-layout"><section className="login-card"><p role="status">{profileError || 'Memuat izin akses…'}</p><button onClick={logout}>Kembali ke login</button></section></main>;
  return <PermissionsContext.Provider value={profile.permissions}><Dashboard displayName={profile.displayName || profile.username} roles={profile.roles ?? []} permissions={profile.permissions} api={api} log={log} entries={entries} logout={() => {
    log('info', 'Logout.');
    logout();
  }} /></PermissionsContext.Provider>;
}
function Dashboard({ api, log, entries, logout, permissions, roles, displayName }: {
  displayName: string;
  roles: string[];
  permissions: string[];
  api: RequestApi;
  log: (level: Entry['level'], message: string, note?: string) => void;
  entries: Entry[];
  logout: () => void
}) {
  const can = (code: string) => permissions.includes(code);
  const hasPcActions = can('equipment.ping') || can('equipment.manage_pc');
  const isAdmin = roles.includes('admin');
  type Page = keyof typeof pagePermissions | 'audit';
  const firstPage: Page | undefined = (Object.keys(pagePermissions) as (keyof typeof pagePermissions)[]).find(key => can(pagePermissions[key])) ?? (isAdmin ? 'audit' : undefined);
  const [page, updatePage] = useState<Page>(firstPage ?? 'activity');
  // Keep visited pages mounted so drafts/results survive navigation; unopened pages do no work.
  const [visited, setVisited] = useState(() => new Set<Page>(firstPage ? [firstPage] : []));
  const setPage = (next: Page) => {
    if (!(next === 'audit' ? isAdmin : can(pagePermissions[next]))) return;
    setVisited(old => old.has(next) ? old : new Set([...old, next]));
    updatePage(next);
  };
  const equipmentVisited = visited.has('equipment');
  const [transactionTarget, setTransactionTarget] = useState<{ cdn: string } | null>(null);
  const [truckTarget, setTruckTarget] = useState<{ equipmentId: number; date: string; cdn: string | null; truck: string | null; eventAt: string } | null>(null);
  const [pcs, setPcs] = useState<Pc[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [apiId, setApiId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [flag, setFlag] = useState(false);
  const [sendMessage, setSendMessage] = useState('');
  const [pcSearch, setPcSearch] = useState('');
  const [truckSearch, setTruckSearch] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const locks = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<Pc | 'new' | null>(null);
  const [lastPing, setLastPing] = useState('Belum diperiksa');
  const logEnd = useRef<HTMLDivElement>(null);
  const selected = pcs.find(pc => pc.id === apiId && pc.online === true);
  const online = pcs.filter(pc => pc.online === true).length;
  const offline = pcs.filter(pc => pc.online === false).length;
  const setError = useCallback((key: string, value: string) => setErrors(old => ({ ...old, [key]: value })), []);
  // Ref mengunci aksi langsung, sebelum React sempat merender state busy.
  // Kunci per aksi: memuat referensi berbeda masih boleh berjalan paralel.
  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setBusy(old => ({ ...old, [key]: true }));
    setError(key, '');
    try {
      await action();
    }
    catch (error) {
      setError(key, message(error));
      log('err', message(error));
    }
    finally {
      locks.current.delete(key);
      setBusy(old => ({ ...old, [key]: false }));
    }
  }, [log, setError]);
  const loadPcs = useCallback(() => run('pcs', async () => {
    log('info', 'Memuat registry dan memeriksa seluruh API.');
    const rows = await api<Pc[]>('/apis');
    setPcs(rows);
    setLastPing(new Date().toLocaleTimeString('id-ID'));
    log('ok', `${rows.length} API dimuat.`, `${rows.filter(pc => pc.online).length} online; ${rows.filter(pc => !pc.online).length} offline.`);
  }), [api, log, run]);
  const loadEquipment = useCallback(() => run('equipment', async () => {
    setEquipment(await api<Equipment[]>('/equipments'));
    log('ok', 'Referensi truck dimuat dari database pusat.');
  }), [api, log, run]);
  const loadLocations = useCallback(() => run('locations', async () => {
    setLocations(await api<Location[]>('/locations'));
    log('ok', 'Referensi lokasi dimuat dari database pusat.');
  }), [api, log, run]);
  useEffect(() => {
    if (equipmentVisited && permissions.includes('equipment.view')) {
      void loadPcs();
      void loadEquipment();
      void loadLocations();
    }
  }, [equipmentVisited, loadPcs, loadEquipment, loadLocations, permissions]);
  useEffect(() => {
    const panel = logEnd.current?.parentElement;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [entries, page]);
  function selectPc(id: string) {
    if (id === apiId || (id && !pcs.some(pc => pc.id === id && pc.online === true))) return;
    setApiId(id);
    setFlag(false);
    setError('send', '');
  }
  function selectTruck(value: string) {
    setTruckSearch(value);
    const matches = equipment.filter(row => `${row.strTruckCN} · #${row.EquipmentID}` === value || row.strTruckCN.toLowerCase() === value.trim().toLowerCase() || String(row.EquipmentID) === value.trim());
    const id = matches.length === 1 ? String(matches[0].EquipmentID) : '';
    if (id === equipmentId) return;
    setEquipmentId(id);
    setFlag(false);
    setError('send', '');
  }
  async function pingAll(pc?: Pc) {
    await run('ping', async () => {
      log('info', pc ? `Ping ${pcLabel(pc)}.` : 'Ping ulang seluruh API.');
      const rows = await api<Pc[]>('/apis/ping', 'POST', pc ? { apiId: pc.id } : {});
      setPcs(old => pc ? old.map(item => rows.find(row => row.id === item.id) || item) : rows);
      setLastPing(new Date().toLocaleTimeString('id-ID'));
      rows.forEach(row => log(row.online ? 'ok' : 'err', `${pcLabel(row)} ${row.online ? 'online' : 'offline'}.`, row.online ? `${row.latency ?? '—'} ms / ${row.method}` : 'ICMP dan TCP port 80 tidak terjangkau.'));
      if (!rows.length) log('info', 'Belum ada API untuk diperiksa.');
    });
  }
  async function send() {
    if (!selected || !equipmentId) return;
    const truck = equipment.find(row => row.EquipmentID === Number(equipmentId));
    if (!await confirmAction(`Kirim konfigurasi ke ${pcLabel(selected)}?\nTruck: ${truck?.strTruckCN || equipmentId}\nLocationID: 0\nisGenerateCDN: ${flag}\n\nKonfigurasi pada API target akan diperbarui.`)) {
      log('info', 'Pengiriman konfigurasi dibatalkan.');
      return;
    }
    await run('send', async () => {
      setSendMessage('');
      log('info', `Mengirim konfigurasi ke ${pcLabel(selected)}.`);
      const result = await api<{
        message: string
      }>('/equipment-checks/upsert', 'POST', { apiId, equipmentID: Number(equipmentId), locationID: 0, isGenerateCDN: flag });
      log('ok', result.message);
      setSendMessage(`Berhasil mengirim konfigurasi truck ${truck?.strTruckCN || equipmentId} ke ${pcLabel(selected)}. ${result.message}`);
      setError('send', '');
    });
  }
  async function removePc(pc: Pc) {
    if (!await confirmAction(`Hapus ${pcLabel(pc)} dari registry?\n\nData equipment checks pada API tidak dihapus.`)) {
      log('info', `Hapus ${pcLabel(pc)} dibatalkan.`);
      return;
    }
    await run('mutation', async () => {
      const result = await api<{
        message: string
      }>(`/apis/${encodeURIComponent(pc.id)}`, 'DELETE');
      setPcs(old => old.filter(row => row.id !== pc.id));
      if (apiId === pc.id) selectPc('');
      log('ok', result.message);
    });
  }
  const pcRows = pcs.filter(pc => `${pc.apiName} ${pc.ipAPI} ${pc.locationIDs.map(id => `${id} ${locations.find(l => l.LocationID === id)?.strLocationName || ''}`).join(' ')}`.toLowerCase().includes(pcSearch.toLowerCase()));
  const pageLabel = { equipment: 'Equipment checks', transactions: 'Analisa transaksi', anomalies: 'Monitoring transaksi', 'truck-history': 'Timeline truck', 'coal-calory': 'Coal calory', activity: 'Activity log', access: 'Manajemen akses', 'biostar-import': 'Import Biostar', audit: 'User Audit' } as const;
  return <div className="workspace">
    <aside className="sidebar">
      <a className="brand" href="#workspace" onClick={() => firstPage && setPage(firstPage)}><span className="brand-mark">IT</span> DEV OPS</a>
      <span className="sidebar-label" hidden={!firstPage}>WORKSPACE</span>
      <nav aria-label="Menu utama" hidden={!firstPage}>
        <button hidden={!can('monitoring.view')} aria-current={page === 'anomalies' ? 'page' : undefined} onClick={() => setPage('anomalies')}><MenuIcon name="anomalies" /> Monitoring transaksi</button>
        <button hidden={!can('equipment.view')} aria-current={page === 'equipment' ? 'page' : undefined} onClick={() => setPage('equipment')}><MenuIcon name="equipment" /> Equipment checks</button>
        <button hidden={!can('transactions.view')} aria-current={page === 'transactions' ? 'page' : undefined} onClick={() => setPage('transactions')}><MenuIcon name="transactions" /> Analisa transaksi</button>
        <button hidden={!can('timeline.view')} aria-current={page === 'truck-history' ? 'page' : undefined} onClick={() => setPage('truck-history')}><MenuIcon name="history" /> Timeline truck</button>
        <button hidden={!can('coal.view')} aria-current={page === 'coal-calory' ? 'page' : undefined} onClick={() => setPage('coal-calory')}><MenuIcon name="calory" /> Coal calory</button>
        {can('biostar.import') && <button className="biostar-nav" aria-current={page === 'biostar-import' ? 'page' : undefined} onClick={() => setPage('biostar-import')}><MenuIcon name="import" /> Import Biostar</button>}
        {can('access.manage') && <button aria-current={page === 'access' ? 'page' : undefined} onClick={() => setPage('access')}><MenuIcon name="access" /> Manajemen akses</button>}
        {isAdmin && <button aria-current={page === 'audit' ? 'page' : undefined} onClick={() => setPage('audit')}><MenuIcon name="audit" /> User Audit</button>}
        <button hidden={!can('activity.view')} aria-current={page === 'activity' ? 'page' : undefined} onClick={() => setPage('activity')}><MenuIcon name="activity" /> Activity log</button>
      </nav>
      <div className="sidebar-bottom">
        <ThemeToggle />
        <span className="sidebar-footer">INTERNAL OPERATIONS<br />IT Dev Ops · v1.0</span>
      </div>
    </aside>
    <header className="topbar">
      <span className="topbar-context">{firstPage ? pageLabel[page] : 'Akses workspace'} <span>/</span> Control workspace</span>
      <div className="topbar-right">
        <div className="signed-in-user" aria-label="User login">
          <strong title={displayName}>{displayName}</strong>
          <span title={roles.join(', ') || 'Tanpa role'}>{roles.join(', ') || 'Tanpa role'}</span>
        </div>
        <button className="icon-button" aria-label="Keluar" title="Keluar" onClick={logout} disabled={busy.send || busy.mutation}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
        </button>
      </div>
    </header>
    <main id="workspace">
      {!firstPage && <p role="status">Belum ada izin menu. Hubungi administrator.</p>}
      {equipmentVisited && can('equipment.view') && <div className="equipment-page menu-page" hidden={page !== 'equipment'}>
        <div className="page-heading">
          <div>
            <h1>Equipment checks</h1>
          </div>
          <div className="heading-actions">
            <span className="muted">Pemeriksaan terakhir <strong className="mono">
              {lastPing}
            </strong></span>
            <button className="icon-button" hidden={!can('equipment.ping')} title="Ping seluruh API" aria-label="Ping seluruh API" aria-busy={!!busy.ping} onClick={() => void pingAll()} disabled={busy.ping || busy.pcs || busy.mutation || !pcs.length}><Icon name="ping" /></button>
          </div>
        </div>
        <section className="summary" aria-label="Ringkasan registry">
          <div>
            <span>API terdaftar</span>
            <strong>
              {pcs.length.toString().padStart(2, '0')}
            </strong>
          </div>
          <div>
            <span><i className="dot online" /> Online</span>
            <strong>
              {online.toString().padStart(2, '0')}
            </strong>
          </div>
          <div>
            <span><i className="dot offline" /> Offline</span>
            <strong>
              {offline.toString().padStart(2, '0')}
            </strong>
          </div>
          <p>Status merupakan hasil pemeriksaan terakhir, bukan pemantauan real-time.</p>
        </section>
        {['equipment', 'locations'].map(key => errors[key] && <div className="error-banner" role="alert" key={key}>
          <span>{key === 'equipment' ? 'Truck' : 'Lokasi'}: {errors[key]}</span>
          <button onClick={() => void (key === 'equipment' ? loadEquipment() : loadLocations())} disabled={busy[key]}>Coba lagi</button>
        </div>)}
        <div className="workspace-body">
          <div className="work-grid">
            <section className="panel registry">
              <div className="panel-heading">
                <div>
                  <span className="section-index">01 / REGISTRY</span>
                  <h2>API target <span className="count">
                    {pcs.length}
                  </span></h2>
                </div>
                <button className="primary icon-button" hidden={!can('equipment.manage_pc')} title="Tambah API" aria-label="Tambah API" onClick={() => {
                  setEditor('new');
                  log('info', 'Membuka formulir tambah API.');
                }} disabled={busy.mutation || busy.pcs || busy.ping}><Icon name="plus" /></button>
              </div>
              <div className="panel-toolbar">
                <label className="search-label">Cari API<input type="search" value={pcSearch} onChange={e => setPcSearch(e.target.value)} placeholder="Nama API, IP, nama atau ID lokasi" /></label>
                <button className="icon-button" title="Muat ulang" aria-label="Muat ulang" aria-busy={!!busy.pcs} onClick={() => void loadPcs()} disabled={busy.pcs || busy.ping || busy.mutation}><Icon name="reload" /></button>
              </div>
              {(errors.pcs || errors.ping || errors.mutation) && <p role="alert" className="error inset">
                {errors.pcs || errors.ping || errors.mutation}
              </p>}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>API / Alamat IP</th>
                      <th>Status</th>
                      <th>Lokasi</th>
                      <th hidden={!hasPcActions}>
                        <span className="sr-only">Aksi</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pcRows.map(pc => <tr key={pc.id} className={apiId === pc.id ? 'selected-row' : ''}>
                      <td>
                        <button className="pc-select" aria-pressed={apiId === pc.id} disabled={busy.send || pc.online !== true} onClick={() => selectPc(pc.id)}>
                          {pc.apiName}
                        </button>
                        <span className="ip mono">
                          {pc.ipAPI}
                        </span>
                      </td>
                      <td>
                        <span className={`status ${pc.online === undefined ? 'unknown' : pc.online ? 'online' : 'offline'}`}>
                          <i className={`dot ${pc.online ? 'online' : pc.online === false ? 'offline' : 'unknown'}`} />
                          {pc.online === undefined ? 'Belum dicek' : pc.online ? 'Online' : 'Offline'}
                        </span>
                        <span className="ip mono">
                          {pc.online ? `${pc.latency ?? '—'} ms · ${pc.method?.toUpperCase()}` : '—'}
                        </span>
                      </td>
                      <td>
                        <div className="location-tags">
                          {pc.locationIDs.map(id => <span key={id} title={`LocationID #${id}`}>
                            {locations.find(l => l.LocationID === id)?.strLocationName || (busy.locations ? 'Memuat lokasi…' : `Nama tidak tersedia (#${id})`)}
                          </span>)}
                          {!pc.locationIDs.length && <span>Belum diatur</span>}
                        </div>
                      </td>
                      <td hidden={!hasPcActions}>
                        <div className="row-actions">
                          <button className="transaction-icon-button" hidden={!can('equipment.ping')} title={`Ping ${pc.apiName}`} aria-busy={!!busy.ping} onClick={() => void pingAll(pc)} disabled={busy.ping || busy.pcs || busy.mutation} aria-label={`Ping ${pc.apiName}`}><Icon name="ping" /></button>
                          <button className="transaction-icon-button" hidden={!can('equipment.manage_pc')} title={`Edit ${pc.apiName}`} onClick={() => {
                            setEditor(pc);
                            log('info', `Edit ${pcLabel(pc)}.`);
                          }} disabled={busy.mutation || busy.send || busy.pcs || busy.ping} aria-label={`Edit ${pc.apiName}`}><Icon name="edit" /></button>
                          <button className="transaction-icon-button danger-text" hidden={!can('equipment.manage_pc')} title={`Hapus ${pc.apiName}`} onClick={() => void removePc(pc)} disabled={busy.mutation || busy.send || busy.pcs || busy.ping} aria-label={`Hapus ${pc.apiName}`}><Icon name="trash" /></button>
                        </div>
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
              {!pcRows.length && <div className="empty">
                <span className="empty-number">
                  {busy.pcs ? '…' : '00'}
                </span>
                <h3>
                  {busy.pcs ? 'Memuat API target' : pcs.length ? 'API tidak ditemukan' : 'Registry masih kosong'}
                </h3>
                <p>
                  {busy.pcs ? 'Memeriksa ICMP dan koneksi TCP.' : pcs.length ? 'Coba kata pencarian lain.' : 'Tambahkan API dan lokasi untuk mulai mengelola konfigurasi.'}
                </p>
              </div>}
              <footer className="panel-footer">{pcRows.length} API ditampilkan <span>Pilih nama API untuk konfigurasi</span></footer>
            </section>
            <section className="panel configuration">
              <div className="panel-heading">
                <div>
                  <span className="section-index">02 / KONFIGURASI</span>
                  <h2>Kirim equipment check</h2>
                </div>
                <span className="small-tag">UPSERT</span>
              </div>
              <div className="form-body">
                <label>API target<select value={selected?.id ?? ''} onChange={e => selectPc(e.target.value)} disabled={busy.send}>
                  <option value="">{online ? 'Pilih API target online' : 'Tidak ada API online'}</option>
                  {pcs.filter(pc => pc.online === true).map(pc => <option key={pc.id} value={pc.id}>{pc.apiName} · {pc.ipAPI}</option>)}
                </select></label>
                <fieldset disabled={busy.send || busy.equipment || !!errors.equipment}>
                  <label htmlFor="truck-picker">Truck / Equipment<Combobox id="truck-picker" value={truckSearch} onChange={selectTruck} options={equipment.map(row => `${row.strTruckCN} · #${row.EquipmentID}`)} placeholder={busy.equipment ? 'Memuat truck…' : 'Ketik nama truck atau EquipmentID'} describedBy="truck-selection" disabled={busy.send || busy.equipment || !!errors.equipment} /></label>
                  <span id="truck-selection" className="helper" role="status">
                    {equipmentId ? `EquipmentID #${equipmentId} terpilih. Dikirim langsung dengan LocationID 0.` : truckSearch ? 'Pilih truck dari saran atau masukkan nama / ID yang cocok.' : 'Pilih sekali. Truck dan equipment memakai pilihan yang sama.'}
                  </span>
                </fieldset>
                <label className="toggle-row">
                  <span>
                    <strong>Generate SK</strong>
                    <small>Nilai flag <code>isGenerateCDN</code></small>
                  </span>
                  <input type="checkbox" role="switch" checked={flag} onChange={e => setFlag(e.target.checked)} disabled={busy.send} />
                  <span className="mono">
                    {String(flag)}
                  </span>
                </label>
                {(busy.send || sendMessage) && <div className="success dismissible-notice" role="status" aria-live="polite" aria-busy={!!busy.send}>
                  <span>{busy.send ? 'Mengirim konfigurasi; menunggu respons API target. Jangan tutup halaman atau kirim ulang…' : sendMessage}</span>
                  {!busy.send && <button type="button" aria-label="Tutup notifikasi" title="Tutup notifikasi" onClick={() => setSendMessage('')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                  </button>}
                </div>}
                {errors.send && <p className="error" role="alert">
                  {errors.send}
                </p>}
                <button hidden={!can('equipment.configure')} className="primary wide" aria-busy={!!busy.send} onClick={() => void send()} disabled={!selected || !equipmentId || busy.send || busy.mutation || busy.equipment || !!errors.equipment}>
                  {busy.send ? 'Mengirim konfigurasi…' : 'Kirim konfigurasi'}
                </button>
                <p className="footnote">Perubahan ditulis langsung ke API target.</p>
              </div>
            </section>
          </div>
        </div>
      </div>}
      <section className="equipment-page activity-page menu-page" hidden={page !== 'activity' || !can('activity.view')} aria-labelledby="activity-title">
        <div className="page-heading"><h1 id="activity-title">Activity log</h1></div>
        <section className="activity">
          <div className="activity-heading"><h2>Catatan sesi <span className="count">{entries.length}</span></h2><span>SESI INI · WAKTU LOKAL</span></div>
          <div className="log-list" role="log" aria-label="Activity log" aria-live="polite">
            {entries.length ? entries.map(entry => <div className="log-entry" key={entry.id}>
              <time>{entry.time}</time><span className={`log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
              <div>{entry.message}{entry.note && <small>{entry.note}</small>}</div>
            </div>) : <p className="muted">Belum ada aktivitas.</p>}
            <div ref={logEnd} />
          </div>
          <footer>Log hanya tersimpan selama halaman terbuka. Bukan audit trail permanen.</footer>
        </section>
      </section>
      <section className="anomaly-view menu-page" hidden={page !== 'anomalies' || !can('monitoring.view')} aria-labelledby="anomalies-title">
        {visited.has('anomalies') && can('monitoring.view') && <AnomalyDashboard api={api} onOpenTransaction={selectedCdn => {
          setTransactionTarget({ cdn: selectedCdn });
          setPage('transactions');
        }} onOpenTruckHistory={target => {
          setTruckTarget(target);
          setPage('truck-history');
        }} />}
      </section>
      <section className="transactions-page menu-page" hidden={page !== 'transactions' || !can('transactions.view')} aria-labelledby="transactions-title">
        {visited.has('transactions') && can('transactions.view') && <Transactions api={api} log={log} initialTarget={transactionTarget} />}
      </section>
      <section className="transactions-page menu-page" hidden={page !== 'truck-history' || !can('timeline.view')} aria-labelledby="truck-history-title">
        {visited.has('truck-history') && can('timeline.view') && <TruckHistory api={api} initialTarget={truckTarget} />}
      </section>
      <section className="equipment-page menu-page" hidden={page !== 'coal-calory' || !can('coal.view')} aria-labelledby="coal-calory-title">
        {visited.has('coal-calory') && can('coal.view') && <CoalCalory api={api} log={log} />}
      </section>
      {page === 'access' && can('access.manage') && <AccessManagement api={api} />}
      {page === 'biostar-import' && can('biostar.import') && <BiostarImport api={api} />}
      {page === 'audit' && isAdmin && <UserAudit api={api} />}
    </main>
    {editor && <PcEditor pc={editor} locations={locations} disabled={!!errors.locations || busy.locations} api={api} log={log} close={() => setEditor(null)} saved={pc => {
      setPcs(old => old.some(row => row.id === pc.id) ? old.map(row => row.id === pc.id ? pc : row) : [...old, pc]);
      setEditor(null);
    }} />}
  </div>;
}
function PcEditor({ pc, locations, disabled, api, log, close, saved }: {
  pc: Pc | 'new';
  locations: Location[];
  disabled: boolean;
  api: RequestApi;
  log: (level: Entry['level'], message: string) => void;
  close: () => void;
  saved: (pc: Pc) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(pc === 'new' ? '' : pc.apiName);
  const [ip, setIp] = useState(pc === 'new' ? '' : pc.ipAPI);
  const [ids, setIds] = useState<number[]>(pc === 'new' ? [] : pc.locationIDs);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const cancel = () => {
    if (!saving.current) {
      log('info', 'Formulir API ditutup tanpa menyimpan.');
      close();
    }
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || disabled) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<Pc>(pc === 'new' ? '/apis' : `/apis/${encodeURIComponent(pc.id)}`, pc === 'new' ? 'POST' : 'PUT', { apiName: name, ipAPI: ip, locationIDs: ids });
      log('ok', `${pc === 'new' ? 'Tambah' : 'Edit'} ${pcLabel(result)} berhasil disimpan.`);
      saved(result);
    } catch (error) {
      setError(message(error));
      log('err', message(error));
    }
    finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const missing = ids.filter(id => !locations.some(l => l.LocationID === id));
  return <dialog ref={dialog} aria-labelledby="pc-editor-title" onCancel={e => {
    e.preventDefault();
    cancel();
  }}>
    <form onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <span className="section-index">REGISTRY API</span>
          <h2 id="pc-editor-title">
            {pc === 'new' ? 'Tambah API target' : 'Edit API target'}
          </h2>
        </div>
        <button type="button" onClick={cancel} disabled={busy}>Tutup</button>
      </div>
      <div className="form-body">
        <label>Nama API<input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="Contoh: WB Kantor Utama" /></label>
        <label>Alamat IPv4<input required value={ip} onChange={e => setIp(e.target.value)} disabled={busy} maxLength={15} placeholder="192.168.1.10" /><span className="helper">Tanpa http://, port, atau path.</span></label>
        <fieldset disabled={busy || disabled}>
          <legend>Lokasi yang dilayani</legend>
          <label>Cari lokasi<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nama atau ID lokasi" /></label>
          <div className="location-picker">
            {locations.filter(l => `${l.LocationID} ${l.strLocationName}`.toLowerCase().includes(search.toLowerCase())).map(location => <label className="check-label" key={location.LocationID}>
              <input type="checkbox" checked={ids.includes(location.LocationID)} onChange={e => setIds(old => e.target.checked ? [...old, location.LocationID] : old.filter(id => id !== location.LocationID))} />
              <span>
                {location.strLocationName}
                <small>LocationID #{location.LocationID}</small>
              </span>
            </label>)}
            {!locations.length && <p className="muted">Referensi lokasi belum tersedia.</p>}
          </div>
        </fieldset>
        {missing.length > 0 && <div className="error">Lokasi tidak aktif/tidak tersedia: {missing.join(', ')}.<button type="button" disabled={busy || disabled} onClick={() => setIds(old => old.filter(id => !missing.includes(id)))}>Hapus dari pilihan</button></div>}
        <span className="helper">{ids.length} lokasi dipilih. Satu API dapat melayani beberapa lokasi.</span>
        {error && <p role="alert" className="error">
          {error}
        </p>}
        {disabled && <p className="error">Referensi lokasi belum tersedia. Muat ulang referensi sebelum menyimpan.</p>}
        <button className="primary wide" aria-busy={busy} disabled={busy || disabled}>
          {busy ? 'Menyimpan…' : 'Simpan API'}
        </button>
      </div>
    </form>
  </dialog>;
}
createRoot(document.getElementById('root')!).render(<App />);
