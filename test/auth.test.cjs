const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const { Reflector } = require('@nestjs/core');
const { AuthDbService, passwordHash, passwordMatches } = require('../dist/auth-db');
const { JwtGuard, RequirePermissions } = require('../dist/auth');
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
