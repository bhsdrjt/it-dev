const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { of, throwError, lastValueFrom } = require('rxjs');
const { BadRequestException, ServiceUnavailableException } = require('@nestjs/common');
const { AuthAuditInterceptor, AccessController } = require('../dist/auth');
const { ApiController } = require('../dist/api');
function run(request = {}, error, auditErrorAt) {
  const rows = [];
  let calls = 0;
  const interceptor = new AuthAuditInterceptor({ audit: async (...args) => {
    if (rows.length === auditErrorAt) throw new ServiceUnavailableException('audit unavailable');
    rows.push(args);
  } });
  const req = { method: 'POST', path: '/transactions/delete', auth: { id: 7 }, ...request };
  const promise = lastValueFrom(interceptor.intercept({ switchToHttp: () => ({ getRequest: () => req }) }, {
    handle: () => { calls++; return error ? throwError(() => error) : of({ ok: true }); }
  }));
  return { rows, promise, calls: () => calls };
}
test('audit records actor, correlated started/success, valid JSON beyond 200 characters and only allowed fields', async () => {
  const r = run({ body: { apiId: 'x'.repeat(220), password: 'SECRET', token: 'SECRET', sql: 'SECRET', nested: { password: 'SECRET' } }, headers: { authorization: 'SECRET' } });
  await r.promise;
  assert.deepEqual(r.rows.map(row => row[4]), ['started', 'succeeded']);
  assert.equal(r.rows[0][0], 7);
  assert.match(r.rows[0][3], /^[a-f0-9]{32}$/);
  assert.equal(r.rows[0][3], r.rows[1][3]);
  assert.equal(JSON.parse(r.rows[0][2]).apiId.length, 220);
  assert(!JSON.stringify(r.rows).includes('SECRET'));
});
test('mutation validation failures are failed; timeout/server errors remain unknown', async () => {
  for (const [error, outcome] of [[new BadRequestException('SECRET'), 'failed'], [new Error('SECRET timeout'), 'unknown'], [new ServiceUnavailableException('SECRET'), 'unknown']]) {
    const r = run({}, error);
    await assert.rejects(r.promise, e => e === error);
    assert.deepEqual(r.rows.map(row => row[4]), ['started', outcome]);
    assert(!JSON.stringify(r.rows).includes('SECRET'));
  }
});
test('audit start failure blocks operation; completion failure leaves durable started and no false failure', async () => {
  const start = run({}, undefined, 0);
  await assert.rejects(start.promise, /audit unavailable/);
  assert.equal(start.calls(), 0);
  const completion = run({}, undefined, 1);
  await assert.rejects(completion.promise, /mungkin sudah diterapkan/);
  assert.deepEqual(completion.rows.map(row => row[4]), ['started']);
  const original = new Error('timeout');
  const failed = run({}, original, 1);
  await assert.rejects(failed.promise, e => e === original);
});
test('operational GET searches and ping audited, read errors failed, auth/me excluded', async () => {
  for (const request of [{ method: 'GET', path: '/transactions/timeline', query: { coalDeliveryNumber: 'CDN', password: 'SECRET', token: 'SECRET', sql: 'SECRET', apiId: { nested: 'SECRET' } } }, { path: '/apis/ping', body: { apiId: 'pc-1' } }]) {
    const r = run(request);
    await r.promise;
    assert.deepEqual(r.rows.map(row => row[4]), ['started', 'succeeded']);
    assert(!JSON.stringify(r.rows).includes('SECRET'));
    if (request.method === 'GET') assert.deepEqual(JSON.parse(r.rows[0][2]).query, { coalDeliveryNumber: 'CDN' });
    const failed = run(request, new Error('timeout'));
    await assert.rejects(failed.promise);
    assert.equal(failed.rows[1][4], 'failed');
  }
  const me = run({ method: 'GET', path: '/auth/me' });
  await me.promise;
  assert.equal(me.rows.length, 0);
  assert(Reflect.getMetadata('__interceptors__', ApiController).includes(AuthAuditInterceptor));
  for (const name of ['users', 'roles']) assert(Reflect.getMetadata('__interceptors__', AccessController.prototype[name]).includes(AuthAuditInterceptor));
});
test('fresh and upgrade migration share data-preserving, rerunnable audit migration', () => {
  const upgrade = readFileSync('sql/user-audit.sql', 'utf8');
  const fresh = readFileSync('sql/itmonitor-auth.sql', 'utf8');
  const block = text => text.split('-- BEGIN USER AUDIT MIGRATION')[1].split('-- END USER AUDIT MIGRATION')[0];
  assert.equal(block(upgrade), block(fresh));
  for (const script of [upgrade, fresh]) {
    assert.match(script, /THROW 50003/);
    assert(script.indexOf('THROW 50003') < script.indexOf('sp_rename'));
    assert.match(script, /sp_rename N'dbo.AuthAudit', N'UserAudit'/);
    assert.match(script, /Target nvarchar\(max\) NOT NULL/);
    assert.match(script, /IX_UserAudit_Actor_CreatedAt/);
    assert.match(script, /IX_UserAudit_OperationId/);
    assert.match(script, /AND NOT EXISTS\(SELECT 1 FROM dbo.UserAudit WHERE Outcome/);
    assert.match(script, /IF @@TRANCOUNT > 0 ROLLBACK/);
    assert.doesNotMatch(script, /DROP TABLE|DELETE dbo\.(AuthAudit|UserAudit)/i);
  }
  for (const path of ['src/auth-db.ts', 'sql/provision-admin.cjs']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /INSERT dbo.UserAudit/);
    assert.doesNotMatch(source, /dbo.AuthAudit/);
  }
  assert.match(readFileSync('src/auth-db.ts', 'utf8'), /input\('target', sql.NVarChar\(sql.MAX\), target\)/);
});
