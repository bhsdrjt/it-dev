const actions: Record<string, string> = {
  'auth.login': 'Login',
  'user.create': 'Tambah user',
  'user.update': 'Ubah user',
  'user.assign': 'Atur role user',
  'role.assign': 'Atur izin role',
  'GET /auth/admin/users': 'Lihat daftar user',
  'GET /auth/admin/roles': 'Lihat role dan izin',
  'GET /apis': 'Lihat daftar PC',
  'POST /apis/ping': 'Periksa koneksi PC',
  'POST /apis': 'Tambah PC',
  'PUT /apis/:id': 'Ubah PC',
  'DELETE /apis/:id': 'Hapus PC',
  'GET /equipments': 'Lihat daftar equipment',
  'POST /transactions/salin-muatan': 'Salin Muatan',
  'GET /transactions/salin-muatan/candidates': 'Lihat kandidat Salin Muatan',
  'POST /transactions/salin-muatan/ke-terima-ada': 'Salin Muatan ke SK Terima yang ada',
  'POST /transactions/generate-sk-terima': 'Buat SK Terima',
  'POST /transactions/delete': 'Hapus transaksi',
  'POST /transactions/restore': 'Pulihkan transaksi',
  'GET /anomalies': 'Lihat anomali',
  'GET /locations': 'Lihat daftar lokasi',
  'GET /coal-calories': 'Lihat kalori batubara',
  'PUT /coal-calories/:id/import': 'Impor kalori batubara',
  'PUT /coal-calories/:id': 'Ubah kalori batubara',
  'DELETE /coal-calories/:id': 'Hapus kalori batubara',
  'GET /transactions/truck-history': 'Lihat Timeline truck',
  'GET /transactions/timeline': 'Lihat Timeline SK',
  'GET /transactions/relations': 'Lihat relasi transaksi',
  'POST /transactions/relations/pair': 'Pasangkan relasi transaksi',
  'POST /transactions/relations': 'Lepas relasi transaksi',
  'POST /transactions/raw-terima': 'Proses ulang RawTerima',
  'GET /equipment-checks': 'Lihat konfigurasi equipment',
  'GET /equipment-checks/location': 'Cari lokasi equipment',
  'POST /equipment-checks/upsert': 'Kirim konfigurasi equipment',
};
export const outcomes: Record<string, string> = { started: 'Dimulai', succeeded: 'Berhasil', failed: 'Gagal', unknown: 'Belum diketahui' };
export function auditOutcome(outcome: string): string {
  return Object.hasOwn(outcomes, outcome) ? outcomes[outcome] : outcome || 'Belum diketahui';
}
export function auditActivity(action: string, outcome: string): string {
  if (action === 'auth.login' && outcome === 'succeeded') return 'Login berhasil';
  return Object.hasOwn(actions, action) ? actions[action] : action;
}
const labels: Record<string, string> = {
  coalDeliveryNumber: 'SK', cdn: 'SK', apiId: 'PC', equipmentID: 'Equipment', equipmentId: 'Equipment',
  locationID: 'Lokasi', nextDT: 'Truck tujuan', truck: 'Truck', kind: 'Jenis transaksi',
  tonnageId: 'ID transaksi', loadingTonnageId: 'ID transaksi kirim', dumpingTonnageId: 'ID transaksi terima',
  ctFinalDumpingTonnageId: 'ID transaksi terima', rawTonnageId: 'ID RawTerima',
  activeOnly: 'Hanya aktif', start: 'Mulai', end: 'Akhir', starttime: 'Mulai', endtime: 'Akhir',
  code: 'Kode anomali', severity: 'Tingkat keparahan', category: 'Kategori',
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function auditTarget(target: string, action: string): string {
  if (action === 'user.create') return target ? `Username: ${target}` : '—';
  if (['auth.login', 'user.update', 'user.assign', 'role.assign'].includes(action) && /^\d+$/.test(target)) {
    return `${action === 'role.assign' ? 'Role' : 'User'} #${target}`;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(target); } catch { return target || '—'; }
  if (!record(parsed)) return target || '—';
  const parts: string[] = [];
  for (const source of [parsed, parsed.query]) {
    if (!record(source)) continue;
    for (const [key, label] of Object.entries(labels)) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) parts.push(`${label}: ${value}`);
    }
  }
  if (typeof parsed.path === 'string') {
    const match = /^\/(apis|coal-calories)\/([^/]+)(?:\/import)?\/?$/.exec(parsed.path);
    if (match && match[2] !== 'ping') {
      let id = match[2];
      try { id = decodeURIComponent(id); } catch { /* Keep malformed legacy IDs readable. */ }
      parts.push(`${match[1] === 'apis' ? 'PC' : 'ID kalori batubara'}: ${id}`);
    }
  }
  return parts.length ? parts.join(' · ') : 'Tidak ada target spesifik';
}
