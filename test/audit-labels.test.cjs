const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const compiled = { exports: {} };
new Function('module', 'exports', transformSync(readFileSync(join(__dirname, '../web/audit-labels.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(compiled, compiled.exports);
const { auditActivity, auditOutcome, auditTarget } = compiled.exports;

test('all current audited API routes and auth actions have human labels', () => {
  const source = readFileSync(join(__dirname, '../src/api.ts'), 'utf8');
  for (const [, method, path] of source.matchAll(/@(Get|Post|Put|Delete|Patch)\('([^']+)'\)/g)) {
    const action = `${method.toUpperCase()} /${path}`;
    assert.notEqual(auditActivity(action, 'started'), action, action);
  }
  for (const action of ['auth.login', 'user.create', 'user.update', 'user.assign', 'role.assign', 'GET /auth/admin/users', 'GET /auth/admin/roles']) assert.notEqual(auditActivity(action, 'started'), action);
  assert.equal(auditActivity('POST /transactions/salin-muatan', 'started'), 'Salin Muatan');
  assert.equal(auditActivity('POST /equipment-checks/upsert', 'succeeded'), 'Kirim konfigurasi equipment');
  assert.equal(auditActivity('GET /transactions/truck-history', 'succeeded'), 'Lihat Timeline truck');
  assert.equal(auditActivity('auth.login', 'succeeded'), 'Login berhasil');
  assert.equal(auditActivity('auth.login', 'failed'), 'Login');
  for (const value of ['DELETE /future-route', '<script>unknown</script>', 'constructor', '__proto__']) assert.equal(auditActivity(value, 'succeeded'), value);
  assert.deepEqual(['started', 'succeeded', 'failed', 'unknown'].map(auditOutcome), ['Dimulai', 'Berhasil', 'Gagal', 'Belum diketahui']);
  assert.equal(auditOutcome('future'), 'future');
});

test('target summary uses stored scalar whitelist only; raw and legacy targets survive', () => {
  assert.equal(auditTarget(JSON.stringify({ coalDeliveryNumber: 'SK1', nextDT: 'DT2', tonnageId: 0, password: 'hidden', path: '/transactions/salin-muatan' }), ''), 'SK: SK1 · Truck tujuan: DT2 · ID transaksi: 0');
  assert.equal(auditTarget(JSON.stringify({ apiId: 'PC1', equipmentID: 12, locationID: 7 }), ''), 'PC: PC1 · Equipment: 12 · Lokasi: 7');
  assert.equal(auditTarget(JSON.stringify({ query: { equipmentId: '42', starttime: '2026-01-01', unknown: 'hidden' } }), ''), 'Equipment: 42 · Mulai: 2026-01-01');
  assert.equal(auditTarget('{"path":"/apis/PC%201"}', ''), 'PC: PC 1');
  assert.equal(auditTarget('{"path":"/coal-calories/42/import"}', ''), 'ID kalori batubara: 42');
  assert.equal(auditTarget('{"path":"/apis/%xx"}', ''), 'PC: %xx');
  for (const target of ['null', '[]', '123', '"legacy"', '{broken', '<img src=x onerror=alert(1)>']) assert.equal(auditTarget(target, ''), target);
  for (const target of ['{}', '{"query":null}', '{"query":[]}', '{"equipmentID":{},"locationID":[],"apiId":false,"nextDT":""}', '{"__proto__":{"equipmentID":3}}']) assert.equal(auditTarget(target, ''), 'Tidak ada target spesifik');
  assert.equal(auditTarget('', ''), '—');
  assert.equal(auditTarget('12', 'auth.login'), 'User #12');
  assert.equal(auditTarget('12', 'user.update'), 'User #12');
  assert.equal(auditTarget('12', 'user.assign'), 'User #12');
  assert.equal(auditTarget('12', 'role.assign'), 'Role #12');
  assert.equal(auditTarget('123', 'user.create'), 'Username: 123');
});
