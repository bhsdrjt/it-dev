const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const { Reflector } = require('@nestjs/core');
const { RequestMethod } = require('@nestjs/common');
const { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { AuthDbService } = require('../dist/auth-db');
const { AccessController, JwtGuard, PERMISSIONS_METADATA } = require('../dist/auth');

const status = code => error => error.getStatus() === code;

test('role name validates JSON, type, blank, trimmed length and all C0/C1 controls before DB calls', async () => {
  const calls = [];
  const controller = new AccessController({ createRole: async (...args) => { calls.push(args); return { id: 42 }; } });
  const request = { auth: { id: 7 } };
  for (const body of [undefined, null, false, [], 'role', {}, { name: null }, { name: 1 }, { name: true }, { name: {} }, { name: [] }, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: ` ${'x'.repeat(101)} ` }]) {
    assert.throws(() => controller.createRole(request, body), status(400));
  }
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
    const control = String.fromCharCode(code);
    for (const name of [`${control}role`, `ro${control}le`, `role${control}`]) {
      assert.throws(() => controller.createRole(request, { name }), status(400));
    }
  }
  assert.equal(calls.length, 0);
  for (const name of ['x', 'x'.repeat(100), ' Tim Operasi ', "O'Brien", '审核员', ' '.repeat(200) + 'role' + ' '.repeat(200)]) {
    assert.deepEqual(await controller.createRole(request, { name, roleIds: [1], userIds: [7], permissionIds: [1] }), { id: 42 });
    assert.deepEqual(calls.at(-1), [7, name.trim()]);
  }
});

test('POST /auth/admin/roles inherits access.manage and JwtGuard; missing JWT and permission denied', async t => {
  const secret = process.env.JWT_SECRET;
  t.after(() => { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });
  process.env.JWT_SECRET = 'role-test-secret-not-for-production-123456789';
  const handler = AccessController.prototype.createRole;
  assert.equal(Reflect.getMetadata(PATH_METADATA, AccessController), 'auth/admin');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'roles');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, AccessController).includes(JwtGuard));
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_METADATA, AccessController), ['access.manage']);
  assert.equal(Reflect.hasOwnMetadata(PERMISSIONS_METADATA, handler), false);
  const user = { id: 7, username: 'manager', displayName: 'Manager', tokenVersion: 3, roles: [], permissions: ['access.manage'] };
  let reads = 0;
  const guard = new JwtGuard({ user: async id => { reads++; assert.equal(id, 7); return user; } }, new Reflector());
  const request = { headers: {} };
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => AccessController };
  await assert.rejects(guard.canActivate(context), status(401));
  request.headers.authorization = 'Bearer invalid';
  await assert.rejects(guard.canActivate(context), status(401));
  assert.equal(reads, 0);
  request.headers.authorization = 'Bearer ' + jwt.sign({ ver: 3 }, process.env.JWT_SECRET, { subject: '7', expiresIn: '1h', issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.auth.id, 7);
  for (const permissions of [[], ['timeline.view']]) {
    user.roles = ['admin']; // Role name alone must not bypass access.manage.
    user.permissions = permissions;
    await assert.rejects(guard.canActivate(context), status(403));
  }
});

function database(t, { insertError, auditError, commitError, admins = true } = {}) {
  const db = new AuthDbService();
  const pool = {};
  const events = [];
  const queries = [];
  const committed = [];
  let pending = [];
  let transaction;
  // Every DB boundary is mocked; unexpected pool connections fail rather than reach a live DB.
  t.mock.method(sql.ConnectionPool.prototype, 'connect', async () => { throw Error('Live DB forbidden'); });
  t.mock.method(db, 'connect', async () => pool);
  t.mock.method(sql.Transaction.prototype, 'begin', async function (isolation) {
    assert.equal(this.parent, pool);
    assert.equal(isolation, sql.ISOLATION_LEVEL.SERIALIZABLE);
    transaction = this;
    events.push('begin');
  });
  t.mock.method(sql.Transaction.prototype, 'commit', async function () {
    assert.equal(this, transaction);
    events.push('commit');
    if (commitError) throw commitError;
    committed.push(...pending);
    pending = [];
  });
  t.mock.method(sql.Transaction.prototype, 'rollback', async function () {
    assert.equal(this, transaction);
    events.push('rollback');
    pending = [];
  });
  t.mock.method(sql.Request.prototype, 'query', async function (statement) {
    assert.equal(this.parent, transaction, 'all queries, including audit, use same transaction');
    const params = Object.fromEntries(Object.entries(this.parameters).map(([key, parameter]) => [key, parameter.value]));
    queries.push({ statement, params, parameters: this.parameters });
    if (/^INSERT dbo.Auth(Roles|Users)\(/.test(statement)) {
      events.push('insert');
      if (insertError) throw insertError;
      pending.push({ kind: 'role', id: 42, name: params.name });
      return { recordset: [{ id: 42 }] };
    }
    if (statement.startsWith('SELECT TOP(1)')) {
      events.push('admins');
      return { recordset: admins ? [{ Id: 7 }] : [] };
    }
    if (statement.startsWith('INSERT dbo.UserAudit')) {
      events.push('audit');
      if (auditError) throw auditError;
      pending.push({ kind: 'audit', ...params });
      return { recordset: [] };
    }
    assert.fail(`Unexpected query: ${statement}`);
  });
  return { db, events, queries, committed, pending: () => pending };
}

test('role creation binds NVARCHAR(100), returns inserted ID, adds no grants and commits audit atomically', async t => {
  const fixture = database(t);
  const name = "operator'); DELETE dbo.AuthUsers;--";
  const controller = new AccessController(fixture.db);
  assert.deepEqual(await controller.createRole({ auth: { id: 7 } }, { name: ` ${name} `, permissionIds: [1], userIds: [7] }), { id: 42 });
  assert.deepEqual(fixture.events, ['begin', 'insert', 'admins', 'audit', 'commit']);
  assert.equal(fixture.queries.length, 3);
  const insert = fixture.queries[0];
  assert.equal(insert.statement, 'INSERT dbo.AuthRoles(Name) OUTPUT inserted.Id AS id VALUES(@name)');
  assert.deepEqual(insert.params, { name });
  assert.equal(insert.parameters.name.type, sql.NVarChar);
  assert.equal(insert.parameters.name.length, 100);
  for (const query of fixture.queries) assert.ok(!query.statement.includes(name));
  assert.deepEqual(fixture.committed, [{ kind: 'role', id: 42, name }, { kind: 'audit', actor: 7, action: 'role.create', target: name }]);
  assert.deepEqual(fixture.pending(), []);
  assert.ok(fixture.queries.every(({ statement }) => !/^(INSERT|UPDATE|DELETE).*dbo.Auth(UserRoles|RolePermissions|Permissions|Users)\b/i.test(statement)));
});

for (const number of [2601, 2627]) {
  test(`role duplicate SQL ${number} rolls back and returns role-specific 409 without audit`, async t => {
    const error = new sql.RequestError('sensitive constraint details', 'EREQUEST');
    error.number = number;
    const fixture = database(t, { insertError: error });
    await assert.rejects(fixture.db.createRole(7, 'existing'), error => error.getStatus() === 409 && error.message === 'Nama role sudah digunakan.');
    assert.deepEqual(fixture.events, ['begin', 'insert', 'rollback']);
    assert.deepEqual(fixture.committed, []);
    assert.deepEqual(fixture.pending(), []);
  });
  test(`user duplicate SQL ${number} preserves existing username message`, async t => {
    const error = new sql.RequestError('sensitive constraint details', 'EREQUEST');
    error.number = number;
    const fixture = database(t, { insertError: error });
    await assert.rejects(fixture.db.createUser(7, 'existing', 'Existing', 'test-only-password', []), error => error.getStatus() === 409 && error.message === 'Username sudah digunakan.');
    assert.deepEqual(fixture.events, ['begin', 'insert', 'rollback']);
    assert.deepEqual(fixture.committed, []);
  });
}

for (const failure of ['insertError', 'auditError', 'commitError', 'admins']) {
  test(`role creation rolls back on ${failure} without partial role or audit`, async t => {
    const fixture = database(t, { [failure]: failure === 'admins' ? false : new Error('sensitive DB details') });
    await assert.rejects(fixture.db.createRole(7, 'new role'), error => error.getStatus() === (failure === 'admins' ? 409 : 503) && !error.message.includes('sensitive'));
    assert.equal(fixture.events.at(-1), 'rollback');
    assert.deepEqual(fixture.committed, []);
    assert.deepEqual(fixture.pending(), []);
    if (failure !== 'commitError') assert.ok(!fixture.events.includes('commit'));
    if (failure === 'admins' || failure === 'insertError') assert.ok(!fixture.events.includes('audit'));
  });
}
