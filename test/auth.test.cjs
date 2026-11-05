const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const { Reflector } = require('@nestjs/core');
const { GUARDS_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { AuthDbService, passwordHash, passwordMatches } = require('../dist/auth-db');
const { JwtGuard, RequirePermissions, PERMISSIONS_METADATA } = require('../dist/auth');
const { BiostarImportController } = require('../dist/biostar.controller');
const { validateEnvironment } = require('../dist/server');
require('@nestjs/common').Logger.overrideLogger(false);
process.env.JWT_SECRET = 'test-only-secret-not-for-production-123456789';

test('scrypt verifies passwords, uses fresh salts and rejects malformed hashes', async () => {
  const hash = await passwordHash('test-only-password');
  assert.match(hash, /^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(await passwordHash('test-only-password'), hash);
  assert.equal(await passwordMatches('test-only-password', hash), true);
  assert.equal(await passwordMatches('wrong', hash), false);
  for (const malformed of ['', 'plaintext', hash.slice(0, -1), hash + '00', hash.replace('scrypt$', 'bcrypt$')]) {
    assert.equal(await passwordMatches('test-only-password', malformed), false);
  }
});

test('JWT guard uses ANY permissions, denies missing metadata and reloads active user/version', async () => {
  const user = { id: 7, username: 'operator', displayName: 'Operator', tokenVersion: 3, roles: [], permissions: ['timeline.view'] };
  let current = user;
  let reads = 0;
  const guard = new JwtGuard({ user: async id => { reads++; assert.equal(id, 7); return current; } }, new Reflector());
  const request = { headers: { authorization: 'Bearer ' + jwt.sign({ ver: 3 }, process.env.JWT_SECRET, { subject: '7', expiresIn: '12h', issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' }) } };
  const handler = () => {};
  class Controller {}
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => Controller };
  RequirePermissions('transactions.view', 'timeline.view')(Controller);
  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.auth.userId, 7);
  current = { ...user, permissions: [] };
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 403);
  RequirePermissions()(Controller);
  assert.equal(await guard.canActivate(context), true);
  Reflect.deleteMetadata('auth.permissions', Controller);
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 403);
  current = undefined;
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
  current = { ...user, tokenVersion: 4 };
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
  request.headers.authorization = 'Bearer invalid';
  const before = reads;
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
  delete request.headers.authorization;
  await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
  assert.equal(reads, before);
});

test('every BioStar route requires unified permission through JwtGuard', async t => {
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_METADATA, BiostarImportController), ['biostar.import']);
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, BiostarImportController).includes(JwtGuard));
  const routes = Object.entries(Object.getOwnPropertyDescriptors(BiostarImportController.prototype))
    .filter(([, descriptor]) => typeof descriptor.value === 'function' && Reflect.hasMetadata(METHOD_METADATA, descriptor.value));
  assert.ok(routes.length > 0);
  const legacy = ['view', 'upload', 'mapping', 'validate', 'confirm', 'cancel', 'start', 'report'].map(action => 'biostar.import.' + action);
  const token = jwt.sign({ ver: 3 }, process.env.JWT_SECRET, { subject: '7', expiresIn: '12h', issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
  for (const [name, { value: handler }] of routes) {
    await t.test(name, async () => {
      assert.equal(Reflect.hasOwnMetadata(PERMISSIONS_METADATA, handler), false);
      const user = { id: 7, username: 'operator', displayName: 'Operator', tokenVersion: 3, roles: [], permissions: ['biostar.import'] };
      let reads = 0;
      // Exercise real guard and route metadata without invoking handlers or connecting to any DB.
      const guard = new JwtGuard({ user: async id => { reads++; assert.equal(id, 7); return user; } }, new Reflector());
      const request = { headers: { authorization: 'Bearer ' + token } };
      const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => BiostarImportController };
      assert.equal(await guard.canActivate(context), true);
      assert.equal(request.auth.userId, 7);
      for (const permissions of [[], ...legacy.map(permission => [permission])]) {
        user.permissions = permissions;
        await assert.rejects(guard.canActivate(context), error => error.getStatus() === 403, `${name}: deny ${permissions.join(',') || 'no permission'}`);
      }
      user.permissions = ['biostar.import'];
      const before = reads;
      request.headers.authorization = 'Bearer invalid';
      await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
      delete request.headers.authorization;
      await assert.rejects(guard.canActivate(context), error => error.getStatus() === 401);
      assert.equal(reads, before);
    });
  }
});

test('BioStar seed creates only unified permission and migration grants only previous start roles', async () => {
  const { readFileSync } = require('node:fs');
  const db = new AuthDbService();
  const inserted = [];
  let seeded = false;
  db.connect = async () => ({ request: () => ({
    input(name, type, value) { assert.equal(name, 'name'); inserted.push(value); return this; },
    async query(statement) {
      if (statement.startsWith('SELECT')) {
        assert.match(statement, /WHERE Name IN \('biostar.import'\)/);
        return { recordset: seeded ? [{ Name: 'biostar.import' }] : [] };
      }
      assert.match(statement, /^INSERT dbo.AuthPermissions/);
      seeded = true;
      return { recordset: [] };
    },
  }) });
  await db.onModuleInit();
  await db.onModuleInit();
  assert.deepEqual(inserted, ['biostar.import']);
  // SQL contract checks only; never run a migration against production from tests.
  const script = readFileSync('sql/biostar-import-permission.sql', 'utf8');
  assert.match(script, /SET XACT_ABORT ON/);
  assert.match(script, /BEGIN TRANSACTION/);
  assert.match(script, /IF @@TRANCOUNT > 0 ROLLBACK;\s+THROW;/);
  const grants = script.slice(script.indexOf('INSERT dbo.AuthRolePermissions'), script.indexOf('DECLARE @legacy'));
  assert.match(grants, /WHERE p.Name = N'biostar.import.start'\s+AND NOT EXISTS/);
  assert.match(grants, /existing.RoleId = rp.RoleId AND existing.PermissionId = @permissionId/);
  assert.doesNotMatch(grants, /\bOR\b|LIKE|admin/i);
  const cleanup = script.slice(script.indexOf('DECLARE @legacy'), script.indexOf('COMMIT;'));
  const legacy = [...cleanup.matchAll(/N'(biostar\.import\.[^']+)'/g)].map(match => match[1]);
  assert.deepEqual(legacy, ['view', 'upload', 'mapping', 'validate', 'confirm', 'cancel', 'start', 'report'].map(name => 'biostar.import.' + name));
  assert.match(cleanup, /DELETE rp FROM dbo.AuthRolePermissions rp JOIN @legacy p ON p.Id = rp.PermissionId/);
  assert.match(cleanup, /DELETE p FROM dbo.AuthPermissions p JOIN @legacy old ON old.Id = p.Id/);
  assert(cleanup.indexOf('DELETE rp') < cleanup.indexOf('DELETE p FROM'));
  const setup = readFileSync('sql/itmonitor-auth.sql', 'utf8');
  assert.match(setup, /WHERE p.Name <> N'biostar.import' AND/);
  assert.match(setup, /INSERT dbo.AuthPermissions\(Name\) VALUES\(N'biostar.import'\)/);
});

test('auth environment requires separate credentials and database', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { DB_SERVER: '127.0.0.1', DB_DATABASE: 'production', DB_USER: 'production-user', DB_PASSWORD: 'production-password', AUTH_DB_USER: 'auth-user', AUTH_DB_PASSWORD: 'auth-password', AUTH_DB_DATABASE: 'ITMonitor' });
  try {
    validateEnvironment();
    for (const key of ['AUTH_DB_USER', 'AUTH_DB_PASSWORD']) {
      const value = process.env[key];
      delete process.env[key];
      assert.throws(validateEnvironment, new RegExp(key));
      process.env[key] = value;
    }
    process.env.AUTH_DB_DATABASE = 'PRODUCTION';
    assert.throws(validateEnvironment, /berbeda/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('auth DB failure returns sanitized 503, retries pool and uses separate credentials', async () => {
  const connect = sql.ConnectionPool.prototype.connect;
  const close = sql.ConnectionPool.prototype.close;
  Object.assign(process.env, { DB_SERVER: '127.0.0.1', DB_DATABASE: 'production', DB_USER: 'production-user', DB_PASSWORD: 'production-password', AUTH_DB_USER: 'auth-user', AUTH_DB_PASSWORD: 'auth-password', AUTH_DB_DATABASE: 'ITMonitor' });
  let attempts = 0;
  sql.ConnectionPool.prototype.connect = async function () {
    assert.equal(this.config.database, 'ITMonitor');
    assert.equal(this.config.user, 'auth-user');
    assert.equal(this.config.password, 'auth-password');
    if (++attempts === 1) throw new Error('sensitive connection details');
    this.request = () => ({ input(name, type, value) { assert.equal(name, 'username'); assert.equal(type.type, sql.NVarChar); assert.equal(value, "operator';--"); return this; }, query: async statement => { assert.match(statement, /Username=@username AND IsActive=1/); return { recordset: [] }; } });
    return this;
  };
  sql.ConnectionPool.prototype.close = async () => undefined;
  const db = new AuthDbService();
  try {
    await assert.rejects(db.credentials("operator';--"), error => error.getStatus() === 503 && !error.message.includes('sensitive'));
    assert.equal(await db.credentials("operator';--"), undefined);
    assert.equal(attempts, 2);
  } finally { await db.onModuleDestroy(); sql.ConnectionPool.prototype.connect = connect; sql.ConnectionPool.prototype.close = close; }
});
