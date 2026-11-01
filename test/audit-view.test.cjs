const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const { Reflector } = require('@nestjs/core');
const { JwtGuard, AccessController, AuthController } = require('../dist/auth');
const { AuthDbService } = require('../dist/auth-db');

test('audit requires actual admin role even with access.manage; me returns roles', async () => {
  process.env.JWT_SECRET = 'fixture-only-audit-secret-12345678901234567890';
  const user = { id: 1, username: 'admin', displayName: 'Admin', roles: [], permissions: ['access.manage'], tokenVersion: 1 };
  const guard = new JwtGuard({ user: async () => user }, new Reflector());
  const request = { headers: { authorization: 'Bearer ' + jwt.sign({ ver: 1 }, process.env.JWT_SECRET, { subject: '1', issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' }) } };
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => AccessController.prototype.audit, getClass: () => AccessController };
  await assert.rejects(guard.canActivate(context), e => e.getStatus() === 403);
  user.roles = ['admin']; user.permissions = [];
  assert.equal(await guard.canActivate(context), true);
  assert.deepEqual(AuthController.prototype.me(request).roles, ['admin']);
  assert.equal(Reflect.getMetadata('__interceptors__', AccessController.prototype.audit), undefined);
});

test('audit HTTP route rejects nonadmin access managers and permits admin read-only', async () => {
  const { Module, Logger } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  Logger.overrideLogger(false);
  const secret = 'fixture-only-audit-http-secret-12345678901234567890';
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  let reads = 0;
  const db = {
    user: async id => ({ id, username: 'fixture', displayName: 'Fixture', tokenVersion: 1, roles: id === 1 ? ['admin'] : [], permissions: id === 1 ? [] : ['access.manage'] }),
    auditRows: async query => { reads++; assert.equal(query.limit, '50'); return { rows: [], offset: 0, limit: 50, hasMore: false }; },
    audit: async () => { assert.fail('Audit browsing must not write'); },
  };
  class FixtureModule {}
  Module({ controllers: [AccessController], providers: [JwtGuard, { provide: AuthDbService, useValue: db }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    assert.equal((await fetch(`${url}/auth/admin/audit?limit=50`)).status, 401);
    for (const id of [2, 1]) {
      const token = jwt.sign({ ver: 1 }, secret, { subject: String(id), issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
      const response = await fetch(`${url}/auth/admin/audit?limit=50`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, id === 1 ? 200 : 403);
      if (id === 1) assert.deepEqual(await response.json(), { rows: [], offset: 0, limit: 50, hasMore: false });
      else assert.equal(reads, 0);
    }
    assert.equal(reads, 1);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test('audit validates before connecting and binds filters, ordering and pagination', async () => {
  const db = new AuthDbService();
  const calls = [];
  db.connect = async () => ({ request: () => ({
    input(name, type, value) { calls.push({ name, type, value }); return this; },
    async query(statement) {
      assert.match(statement, /LEFT JOIN dbo.AuthUsers/);
      assert.match(statement, /ORDER BY a.CreatedAt DESC, a.Id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY/);
      assert.ok(!statement.includes("evil';--"));
      return { recordset: Array.from({ length: 51 }, (_, id) => ({ id: String(id) })) };
    }
  }) });
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { offset: '-1' }, { offset: '1000001' }, { limit: ['50'] }, { user: {} }, { outcome: 'bad' }, { start: '2026-02-30T00:00:00' }, { start: '2026-02-01T00:00:00', end: '2026-01-01T00:00:00' }]) {
    await assert.rejects(db.auditRows(query), e => e.getStatus() === 400);
  }
  assert.equal(calls.length, 0);
  const result = await db.auditRows({ user: "evil';--", outcome: 'failed', start: '2026-01-01T00:00:00', end: '2026-02-01T00:00:00' });
  assert.equal(result.rows.length, 50); assert.equal(result.hasMore, true); assert.equal(result.offset, 0);
  const values = Object.fromEntries(calls.map(x => [x.name, x.value]));
  assert.deepEqual(values, { limit: 51, offset: 0, user: "evil';--", outcome: 'failed', start: new Date('2026-01-01Z'), end: new Date('2026-02-01Z') });
  assert.equal(calls.find(x => x.name === 'offset').type, sql.Int);
  assert.equal(calls.find(x => x.name === 'start').type, sql.DateTime2);
  const page = await db.auditRows({ limit: '100', offset: '1000000' });
  assert.equal(page.hasMore, false);
});
