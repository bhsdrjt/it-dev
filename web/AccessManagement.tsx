import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { confirmAction } from './confirm-action';
import { Icon } from './Icon';
import './access-management.css';

type User = { id: number; username: string; displayName: string; isActive: boolean };
type Role = { id: number; name: string };
type Users = { users: User[]; userRoles: { userId: number; roleId: number }[] };
type Roles = { roles: Role[]; permissions: Role[]; rolePermissions: { roleId: number; permissionId: number }[] };
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

function AccessEditor({ title, icon = 'edit', disabled, error, notice, onOpen, children }: { title: string; icon?: 'edit' | 'plus'; disabled: boolean; error: string; notice: string; onOpen: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return <>
    <button type="button" className="access-edit-button" title={title} aria-label={title} aria-haspopup="dialog" disabled={disabled} onClick={() => { onOpen(); dialog.current?.showModal(); }}><Icon name={icon} /></button>
    <dialog ref={dialog} className="access-modal" aria-labelledby={titleId} onCancel={event => { if (disabled) event.preventDefault(); }}>
      <header className="access-modal-heading"><h2 id={titleId}>{title}</h2><button type="button" className="access-edit-button" autoFocus title="Tutup" aria-label="Tutup" disabled={disabled} onClick={() => dialog.current?.close()}><Icon name="close" /></button></header>
      <div className="access-modal-body">
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="access-notice" role="status">{notice}</p>}
        {children}
      </div>
    </dialog>
  </>;
}

export function AccessManagement({ api }: { api: Api }) {
  const [users, setUsers] = useState<Users>({ users: [], userRoles: [] });
  const [roles, setRoles] = useState<Roles>({ roles: [], permissions: [], rolePermissions: [] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, r] = await Promise.all([api<Users>('/auth/admin/users'), api<Roles>('/auth/admin/roles')]);
      setUsers(u); setRoles(r); setLoaded(true);
    } finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : 'Gagal memuat akses.')); }, [load]);
  async function save(path: string, method: string, body: unknown) {
    if (busy || loading) return false;
    setBusy(true);
    try {
      if (!await confirmAction('Simpan perubahan akses? Sesi user terkait dapat dibatalkan.')) return false;
      setError(''); setNotice('');
      await api(path, method, body);
      setNotice('Perubahan akses tersimpan.');
      try { await load(); }
      catch { setError('Perubahan tersimpan, tetapi daftar gagal dimuat ulang. Klik Muat ulang.'); }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan akses.');
      return false;
    } finally { setBusy(false); }
  }
  const ids = (form: FormData, key: string) => form.getAll(key).map(Number);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    if (await save('/auth/admin/users', 'POST', { username: form.get('username'), displayName: form.get('displayName'), password: form.get('password'), roleIds: ids(form, 'roleIds') })) element.reset();
  }
  const matches = (user: User) => `${user.username} ${user.displayName}`.toLowerCase().includes(query.trim().toLowerCase()) && (status === 'all' || user.isActive === (status === 'active'));
  const visibleCount = users.users.filter(matches).length;
  const disabled = busy || loading;
  return <div className="access-page menu-page">
    <header className="page-heading access-heading">
      <h1>Manajemen akses</h1>
      <button className="access-button" disabled={disabled} onClick={() => { setError(''); void load().catch(e => setError(e instanceof Error ? e.message : 'Gagal memuat akses.')); }}><Icon name="reload" />Muat ulang</button>
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="access-notice" role="status">{notice}</p>}
    <nav className="access-tabs" aria-label="Bagian manajemen akses">
      <button id="access-users-tab" aria-pressed={tab === 'users'} aria-controls="access-users" onClick={() => setTab('users')}>User <span>{loaded ? users.users.length : '…'}</span></button>
      <button id="access-roles-tab" aria-pressed={tab === 'roles'} aria-controls="access-roles" onClick={() => setTab('roles')}>Role & izin <span>{loaded ? roles.roles.length : '…'}</span></button>
    </nav>
    {loading && <p className="access-loading" role="status">Memuat data akses…</p>}
    <section id="access-users" className="access-section" aria-labelledby="access-users-tab" hidden={tab !== 'users' || !loaded}>
      <section className="access-card access-directory" aria-labelledby="access-directory-title">
        <header className="access-card-heading"><h2 id="access-directory-title">Daftar user <span className="access-total">· {users.users.filter(user => user.isActive).length} aktif</span></h2>
        <AccessEditor title="Tambah user" icon="plus" disabled={disabled} error={error} notice={notice} onOpen={() => { setError(''); setNotice(''); }}>
        <form className="access-form" onSubmit={create}><fieldset disabled={disabled}>
          <legend>Identitas user baru</legend>
          <div className="access-fields">
            <label>Username<input name="username" required maxLength={200} autoComplete="off" /></label>
            <label>Nama tampilan<input name="displayName" required maxLength={200} autoComplete="off" /></label>
            <label>Password<input name="password" type="password" required minLength={12} maxLength={1000} autoComplete="new-password" /><span className="helper">Minimal 12 karakter.</span></label>
          </div>
          <fieldset><legend>Role awal</legend><div className="access-options">
            {roles.roles.map(role => <label className="access-option" key={role.id}><input type="checkbox" name="roleIds" value={role.id} /><span>{role.name}</span></label>)}
          </div>{!roles.roles.length && <p className="helper">Belum ada role tersedia.</p>}</fieldset>
          <footer className="access-form-footer"><span>Periksa identitas dan role sebelum membuat akun.</span><button className="primary">Tambah user</button></footer>
        </fieldset></form>
        </AccessEditor>
        </header>
        <div className="access-toolbar">
          <label className="access-search">Cari user<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nama atau username" /></label>
          <label>Status akun<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">Semua status</option><option value="active">Aktif</option><option value="inactive">Nonaktif</option></select></label>
          <span className="access-result-count" role="status">{visibleCount} dari {users.users.length} user</span>
        </div>
        <div className="access-list">
          {users.users.map(user => {
            const assignedRoles = roles.roles.filter(role => users.userRoles.some(link => link.userId === user.id && link.roleId === role.id));
            return <article className="access-record" key={user.id} hidden={!matches(user)}>
              <div className="access-record-row">
                <span className="access-avatar" aria-hidden="true">{(user.displayName || user.username).slice(0, 2).toUpperCase()}</span>
                <span className="access-identity"><strong>{user.displayName || user.username}</strong><span>@{user.username}</span></span>
                <span className="access-role-summary">{assignedRoles.length ? assignedRoles.map(role => role.name).join(', ') : 'Belum ada role'}</span>
                <span className={`access-status ${user.isActive ? 'is-active' : ''}`}>{user.isActive ? 'Aktif' : 'Nonaktif'}</span>
                <AccessEditor title={`Kelola user · ${user.username}`} disabled={disabled} error={error} notice={notice} onOpen={() => { setError(''); setNotice(''); }}>
              <div className="access-user-editor">
                <form className="access-form" key={`${user.displayName}:${user.isActive}`} onSubmit={async event => {
                  event.preventDefault();
                  const element = event.currentTarget;
                  const form = new FormData(element);
                  const password = String(form.get('password') ?? '');
                  if (await save(`/auth/admin/users/${user.id}`, 'PUT', { displayName: form.get('displayName'), isActive: form.has('isActive'), ...(password ? { password } : {}) })) {
                    const input = element.elements.namedItem('password');
                    if (input instanceof HTMLInputElement) input.value = '';
                  }
                }}><fieldset disabled={disabled}>
                  <legend>Profil & keamanan</legend>
                  <div className="access-fields">
                    <label>Nama tampilan<input name="displayName" required maxLength={200} defaultValue={user.displayName} /></label>
                    <label>Password baru<input name="password" type="password" minLength={12} maxLength={1000} autoComplete="new-password" /><span className="helper">Minimal 12 karakter. Kosongkan jika tidak diubah.</span></label>
                  </div>
                  <label className="access-option access-active-option"><input name="isActive" type="checkbox" defaultChecked={user.isActive} /><span>Akun aktif<small>User dapat masuk ke workspace.</small></span></label>
                  <footer className="access-form-footer"><button className="primary">Simpan user</button></footer>
                </fieldset></form>
                <form className="access-form" key={assignedRoles.map(role => role.id).join(',')} onSubmit={event => { event.preventDefault(); void save(`/auth/admin/users/${user.id}/roles`, 'PUT', { roleIds: ids(new FormData(event.currentTarget), 'roleIds') }); }}><fieldset disabled={disabled}>
                  <legend>Role user</legend>
                  <p className="helper">Izin user mengikuti seluruh role yang dipilih.</p>
                  <div className="access-options">{roles.roles.map(role => <label className="access-option" key={role.id}><input name="roleIds" type="checkbox" value={role.id} defaultChecked={assignedRoles.some(assigned => assigned.id === role.id)} /><span>{role.name}</span></label>)}</div>
                  {!roles.roles.length && <p className="helper">Belum ada role tersedia.</p>}
                  <footer className="access-form-footer"><button>Simpan role</button></footer>
                </fieldset></form>
              </div>
                </AccessEditor>
              </div>
            </article>;
          })}
          {!visibleCount && <div className="access-empty"><h3>{users.users.length ? 'User tidak ditemukan' : 'Belum ada user'}</h3><p>{users.users.length ? 'Coba nama lain atau ubah filter status.' : 'Buka Tambah user untuk membuat akun pertama.'}</p></div>}
        </div>
      </section>
    </section>
    <section id="access-roles" className="access-section" aria-labelledby="access-roles-tab" hidden={tab !== 'roles' || !loaded}>
      <section className="access-card" aria-labelledby="access-role-title">
        <header className="access-card-heading"><h2 id="access-role-title">Role & izin workspace</h2><span className="access-total">{roles.permissions.length} izin</span></header>
        <div className="access-list">
          {roles.roles.map(role => {
            const assigned = roles.rolePermissions.filter(link => link.roleId === role.id).map(link => link.permissionId);
            return <article className="access-record access-role-record" key={role.id}>
              <div className="access-record-row"><span className="access-identity"><strong>{role.name}</strong><span>{users.userRoles.filter(link => link.roleId === role.id).length} user</span></span><span className="access-total">{assigned.length} dari {roles.permissions.length} izin</span>
                <AccessEditor title={`Atur izin · ${role.name}`} disabled={disabled} error={error} notice={notice} onOpen={() => { setError(''); setNotice(''); }}>
              <form className="access-form" key={assigned.join(',')} onSubmit={event => { event.preventDefault(); void save(`/auth/admin/roles/${role.id}/permissions`, 'PUT', { permissionIds: ids(new FormData(event.currentTarget), 'permissionIds') }); }}><fieldset disabled={disabled}>
                <legend>Izin untuk {role.name}</legend>
                <div className="access-options">{roles.permissions.map(permission => <label className="access-option" key={permission.id}><input name="permissionIds" type="checkbox" value={permission.id} defaultChecked={assigned.includes(permission.id)} /><span>{permission.name}</span></label>)}</div>
                {!roles.permissions.length && <p className="helper">Belum ada izin tersedia.</p>}
                <footer className="access-form-footer"><button className="primary">Simpan izin</button></footer>
              </fieldset></form>
                </AccessEditor>
              </div>
            </article>;
          })}
          {!roles.roles.length && <div className="access-empty"><h3>Belum ada role</h3><p>Role yang tersedia akan muncul di sini.</p></div>}
        </div>
      </section>
    </section>
  </div>;
}
