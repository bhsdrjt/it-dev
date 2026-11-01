import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { confirmAction } from './confirm-action';
import './access-management.css';

type User = { id: number; username: string; displayName: string; isActive: boolean };
type Role = { id: number; name: string };
type Users = { users: User[]; userRoles: { userId: number; roleId: number }[] };
type Roles = { roles: Role[]; permissions: Role[]; rolePermissions: { roleId: number; permissionId: number }[] };
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function AccessManagement({ api }: { api: Api }) {
  const [users, setUsers] = useState<Users>({ users: [], userRoles: [] });
  const [roles, setRoles] = useState<Roles>({ roles: [], permissions: [], rolePermissions: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [u, r] = await Promise.all([api<Users>('/auth/admin/users'), api<Roles>('/auth/admin/roles')]);
    setUsers(u); setRoles(r);
  }, [api]);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : 'Gagal memuat akses.')); }, [load]);
  async function save(path: string, method: string, body: unknown) {
    if (busy || !await confirmAction('Simpan perubahan akses? Sesi pengguna terkait dapat dibatalkan.')) return;
    setBusy(true); setError('');
    try { await api(path, method, body); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal menyimpan akses.'); }
    finally { setBusy(false); }
  }
  const ids = (form: FormData, key: string) => form.getAll(key).map(Number);
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save('/auth/admin/users', 'POST', { username: form.get('username'), displayName: form.get('displayName'), password: form.get('password'), roleIds: ids(form, 'roleIds') });
  }
  return <div className="access-page menu-page">
    <div className="page-heading"><h1>Manajemen akses</h1><button disabled={busy} onClick={() => void load().catch(e => setError(String(e)))}>Muat ulang</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="access-card"><h2>Tambah pengguna</h2><form className="access-form" onSubmit={create}><fieldset disabled={busy}>
      <legend>Identitas pengguna</legend>
      <div className="access-fields"><label>Username<input name="username" required maxLength={200} autoComplete="off" /></label>
      <label>Nama<input name="displayName" required maxLength={200} /></label>
      <label>Password<input name="password" type="password" required minLength={12} maxLength={1000} autoComplete="new-password" /></label>
      </div>
      <fieldset><legend>Role awal</legend><div className="access-options">
        {roles.roles.map(role => <label className="access-option" key={role.id}><input type="checkbox" name="roleIds" value={role.id} /><span>{role.name}</span></label>)}
      </div></fieldset>
      <button className="primary">Tambah</button>
    </fieldset></form></section>
    {users.users.map(user => <section className="access-card" key={`${user.id}:${JSON.stringify(users.userRoles)}:${user.displayName}:${user.isActive}`}><h2>{user.username}</h2>
      <form className="access-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get('password') ?? ''); void save(`/auth/admin/users/${user.id}`, 'PUT', { displayName: form.get('displayName'), isActive: form.has('isActive'), ...(password ? { password } : {}) }); }}><fieldset disabled={busy}>
        <legend>Identitas pengguna</legend>
        <div className="access-fields">
          <label>Nama<input name="displayName" required maxLength={200} defaultValue={user.displayName} /></label>
          <label>Password baru<input name="password" type="password" minLength={12} maxLength={1000} autoComplete="new-password" /><span className="helper">Kosongkan jika tidak diubah.</span></label>
        </div>
        <label className="access-option"><input name="isActive" type="checkbox" defaultChecked={user.isActive} /><span>Aktif</span></label>
        <button>Simpan pengguna</button>
      </fieldset></form>
      <form className="access-form" onSubmit={event => { event.preventDefault(); void save(`/auth/admin/users/${user.id}/roles`, 'PUT', { roleIds: ids(new FormData(event.currentTarget), 'roleIds') }); }}><fieldset disabled={busy}><legend>Role</legend>
        <div className="access-options">{roles.roles.map(role => <label className="access-option" key={role.id}><input name="roleIds" type="checkbox" value={role.id} defaultChecked={users.userRoles.some(link => link.userId === user.id && link.roleId === role.id)} /><span>{role.name}</span></label>)}</div><button>Simpan role</button>
      </fieldset></form>
    </section>)}
    {roles.roles.map(role => <section className="access-card" key={`${role.id}:${JSON.stringify(roles.rolePermissions)}`}><h2>{role.name}</h2><form className="access-form" onSubmit={event => { event.preventDefault(); void save(`/auth/admin/roles/${role.id}/permissions`, 'PUT', { permissionIds: ids(new FormData(event.currentTarget), 'permissionIds') }); }}><fieldset disabled={busy}><legend>Izin</legend>
      <div className="access-options">{roles.permissions.map(permission => <label className="access-option" key={permission.id}><input name="permissionIds" type="checkbox" value={permission.id} defaultChecked={roles.rolePermissions.some(link => link.roleId === role.id && link.permissionId === permission.id)} /><span>{permission.name}</span></label>)}</div><button>Simpan izin</button>
    </fieldset></form></section>)}
  </div>;
}
