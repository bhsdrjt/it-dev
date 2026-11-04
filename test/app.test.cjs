const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const jwt = require('jsonwebtoken');
const ping = require('ping');
const axios = require('axios');
const sql = require('mssql');
const { PcRegistryService } = require('../dist/registry');
const { PcService, normalizeChecks } = require('../dist/pc');
const { DbService } = require('../dist/db');
const { AuthDbService, passwordHash } = require('../dist/auth-db');
const { pcInput, queryInteger } = require('../dist/validation');
const { createApp, validateEnvironment } = require('../dist/server');
require('@nestjs/common').Logger.overrideLogger(false);

process.env.JWT_SECRET = 'test-only-secret-not-for-production-123456789';
process.env.AUTH_DB_USER = 'auth-test';
process.env.AUTH_DB_PASSWORD = 'auth-test-password';
process.env.AUTH_DB_DATABASE = 'ITMonitor';
process.env.DB_SERVER = '127.0.0.1';
process.env.DB_PORT = '9';
process.env.DB_DATABASE = 'test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
const pc = { id: 'test-pc', apiName: 'WB Test', ipAPI: '192.0.2.10', locationIDs: [7, 8] };
const tempRoot = process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd();

test('input validation and case-insensitive response normalization', () => {
  assert.deepEqual(pcInput({ ...pc, locationIDs: [0, 7, 7] }).locationIDs, [0, 7]);
  for (const ipAPI of ['256.1.1.1', '127.1', 'host.local', '192.0.2.1/path', '192.0.2.1:80', 'http://127.0.0.1']) assert.throws(() => pcInput({ ...pc, ipAPI }));
  for (const locationIDs of [[-1], ['7'], [1.2], [Infinity], null]) assert.throws(() => pcInput({ ...pc, locationIDs }));
  assert.equal(queryInteger('0', 'id'), 0);
  for (const value of ['', '-1', '1e2', '2.3', [], '2147483648']) assert.throws(() => queryInteger(value, 'id'));
  const expected = [{ equipmentID: 10, locationID: 7, isGenerateCDN: false }];
  for (const wrapper of [rows => rows, rows => ({ DATA: rows }), rows => ({ Items: rows }), rows => ({ result: { Data: rows } })]) {
    assert.deepEqual(normalizeChecks(wrapper([{ EQUIPMENTID: '10', LocationID: 7, isGenerateCDN: 'false' }])), expected);
  }
  assert.deepEqual(normalizeChecks({ data: [] }), []);
  for (const value of [null, {}, { data: null }, [{ equipmentID: null, locationID: 1, isGenerateCDN: false }], [{ equipmentID: 1, locationID: 1, isGenerateCDN: 'wrong' }]]) assert.throws(() => normalizeChecks(value));
});

test('ICMP success, TCP fallback, offline and upstream write uncertainty', async () => {
  const originalProbe = ping.promise.probe;
  const originalRequest = axios.request;
  const service = new PcService();
  let tcpCalls = 0;
  service.tcp = async () => { tcpCalls++; return 5; };
  try {
    ping.promise.probe = async () => ({ alive: true, time: 3 });
    assert.equal((await service.status(pc)).method, 'icmp');
    assert.equal(tcpCalls, 0);
    ping.promise.probe = async () => ({ alive: false });
    assert.equal((await service.status(pc)).method, 'tcp');
    ping.promise.probe = async () => { throw new Error('utility missing'); };
    assert.equal((await service.status(pc)).online, true);
    service.tcp = async () => null;
    assert.equal((await service.status(pc)).online, false);
    await assert.rejects(service.requireTcp(pc), /WB Test.*192\.0\.2\.10.*offline/);
    axios.request = async options => {
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.proxy, false);
      assert.equal(options.timeout, 10000);
      assert.match(options.url, /\/SNCAutoWBLocalAPI\/api\/EquipmentChecks\/upsert$/);
      throw new Error('socket closed after write');
    };
    await assert.rejects(service.request(pc, 'POST', { data: {} }), /Muat ulang data sebelum mencoba kirim lagi/);
  } finally { ping.promise.probe = originalProbe; axios.request = originalRequest; }
});

test('DB connection failure returns 503 and next request recreates pool', async () => {
  const connect = sql.ConnectionPool.prototype.connect;
  const close = sql.ConnectionPool.prototype.close;
  let attempts = 0;
  sql.ConnectionPool.prototype.connect = async function () {
    attempts++;
    if (attempts === 1) throw new Error('sensitive database connection details');
    this.request = () => ({ query: async () => ({ recordset: [{ EquipmentID: 10, strTruckCN: 'TR-10' }] }) });
    return this;
  };
  sql.ConnectionPool.prototype.close = async () => undefined;
  try {
    const db = new DbService();
    await assert.rejects(db.equipments(), error => error.getStatus() === 503 && !error.message.includes('sensitive'));
    assert.equal((await db.equipments())[0].EquipmentID, 10);
    assert.equal(attempts, 2);
    await db.onModuleDestroy();
  } finally { sql.ConnectionPool.prototype.connect = connect; sql.ConnectionPool.prototype.close = close; }
});

test('truck timeline binds varchar parameter, preserves both result sets and handles SQL errors', async () => {
  const connect = sql.ConnectionPool.prototype.connect;
  const close = sql.ConnectionPool.prototype.close;
  let failure;
  const transactions = [{ Transaksi: 'Loading', CoalDeliveryNumber: 'AF260080419', IsValid: false }, { Transaksi: 'RawDumping', CoalDeliveryNumber: 'OTHER', IsValid: null }];
  const activities = [{ trans: 'Tol Gate', CoalDeliveryNumber: null, flTonnage: 0 }];
  const number = "AF'; DROP TABLE test;--";
  sql.ConnectionPool.prototype.connect = async function () {
    this.request = () => ({
      overrides: {},
      input(name, type, value) { assert.equal(name, 'CoalDeliveryNumber'); assert.equal(type.type, sql.VarChar); assert.equal(type.length, 50); assert.equal(value, number); return this; },
      async execute(procedure) { assert.equal(procedure, 'dbo.usp_GetTruckTimelineByCoalDelivery'); assert.equal(this.overrides.requestTimeout, 60000); if (failure) throw failure; return { recordsets: [transactions, activities] }; },
    });
    return this;
  };
  sql.ConnectionPool.prototype.close = async () => undefined;
  const db = new DbService();
  try {
    const timeline = await db.truckTimeline(number);
    assert.equal(timeline.coalDeliveryNumber, number);
    assert.deepEqual(timeline.transactions, transactions);
    assert.deepEqual(timeline.activities, activities);
    assert.match(timeline.queries[0], /^EXEC dbo\.usp_GetTruckTimelineByCoalDelivery/);
    failure = { number: 50001 };
    await assert.rejects(db.truckTimeline(number), error => error.getStatus() === 404);
    failure = new Error('sensitive SQL details');
    await assert.rejects(db.truckTimeline(number), error => error.getStatus() === 503 && !error.message.includes('sensitive'));
  } finally { await db.onModuleDestroy(); sql.ConnectionPool.prototype.connect = connect; sql.ConnectionPool.prototype.close = close; }
});

test('RawTerima replay binds raw ID, guards ambiguous/existing rows, verifies insert and rolls back failures', async () => {
  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query, execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'test' });
  let scenario, executions, commits, rollbacks;
  const raw = { EquipmentID: 1386, dtTimeCollected: new Date('2026-03-16T20:06:09.880Z'), dtDeletedAt: null };
  sql.Transaction.prototype.begin = async () => undefined;
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw new Error('sensitive commit error'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    assert.equal(this.parameters.id.value, 19592476);
    if (statement.includes('tabCTFinalDumpingTonnageRaw')) {
      assert.match(statement, /UPDLOCK, HOLDLOCK/);
      assert.match(statement, /WHERE CTFinalDumpingTonnageRawID = @id/);
      assert.doesNotMatch(statement, /CoalDeliveryNumber/);
      return { recordset: scenario === 'missing' ? [] : scenario === 'ambiguous' ? [raw, raw] : [{ ...raw, dtDeletedAt: scenario === 'deleted' ? raw.dtTimeCollected : null }] };
    }
    assert.equal(this.parameters.EquipmentID.value, 1386);
    if (statement.includes('TOP (1)')) return { recordset: scenario === 'existing' ? [{ CTFinalDumpingTonnageID: 1 }] : [] };
    return { recordset: scenario === 'no-insert' ? [] : [{ CTFinalDumpingTonnageID: 42 }] };
  };
  sql.Request.prototype.execute = async function (procedure) {
    executions++;
    assert.equal(procedure, 'dbo.usp_DebugCTFinalDumpingTonnagebyID');
    assert.deepEqual(Object.keys(this.parameters), ['id']);
    assert.equal(this.parameters.id.type, sql.Int);
    assert.equal(this.parameters.id.value, 19592476);
    assert.equal(this.overrides.requestTimeout, 60000);
    if (scenario === 'sql-error') throw new Error('sensitive SQL failure');
    return {};
  };
  try {
    for (scenario of ['success', 'missing', 'ambiguous', 'deleted', 'existing', 'no-insert', 'sql-error', 'commit-error']) {
      executions = commits = rollbacks = 0;
      if (scenario === 'success') assert.match((await db.promoteRawDumping(19592476)).message, /Terima #42/);
      else await assert.rejects(db.promoteRawDumping(19592476), error => {
        assert.equal(error.getStatus(), scenario === 'missing' ? 404 : ['sql-error', 'commit-error'].includes(scenario) ? 503 : 409);
        assert.ok(!error.message.includes('sensitive'));
        return true;
      });
      assert.equal(executions, ['success', 'no-insert', 'sql-error', 'commit-error'].includes(scenario) ? 1 : 0);
      assert.equal(commits, scenario === 'success' ? 1 : 0);
      assert.equal(rollbacks, scenario === 'success' ? 0 : 1);
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = originals[name];
    for (const name of ['query', 'execute']) sql.Request.prototype[name] = originals[name];
  }
});

test('relation lookup binds dumping ID in both directions and retains deleted records', async () => {
  const db = new DbService();
  const rows = [{ CTFinalLoadingTonnageID: 11, dtDeletedAt: '2026-01-01' }];
  let kind;
  db.read = async action => action({
    input(name, type, value) { assert.equal(name, 'id'); assert.equal(type, sql.Int); assert.equal(value, 20); return this; },
    async query(statement) {
      assert.equal(statement, kind === 'Kirim' ? 'SELECT * FROM dbo.tabCTFinalDumpingTonnage WHERE CTFinalDumpingTonnageID = @id' : 'SELECT * FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalDumpingTonnageID = @id');
      return { recordset: rows };
    },
  });
  for (kind of ['Kirim', 'Terima']) assert.deepEqual(await db.relatedTransactions(kind, 20), rows);
});

test('manual pairing binds ID, guards candidates and owners, verifies result and rolls back', async () => {
  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query, execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'test' });
  let scenario, executions, commits, rollbacks;
  const time = new Date('2026-04-21T17:21:40.000Z');
  sql.Transaction.prototype.begin = async () => undefined;
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw Error('sensitive'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    assert.equal(this.parameters.CTFinalLoadingTonnageID.value, 10);
    if (statement.includes('SELECT CTFinalDumpingTonnageID, EquipmentID')) return { recordset: scenario === 'missing' ? [] : [{ CTFinalDumpingTonnageID: scenario === 'linked' ? 20 : null, EquipmentID: scenario === 'incomplete' ? null : 1, dtLoaded: time, dtDeletedAt: scenario === 'deleted' ? time : null }] };
    if (statement.includes('SELECT TOP (2)')) {
      assert.match(statement, /dtEmpty >= @dtLoaded/);
      assert.match(statement, /ORDER BY dtEmpty ASC/);
      assert.doesNotMatch(statement, /ORDER BY dtTimeCollected/);
      assert.match(statement, /UPDLOCK, HOLDLOCK/);
      return { recordset: scenario === 'no-candidate' ? [] : [{ CTFinalDumpingTonnageID: 20, dtEmpty: scenario === 'no-time' ? null : time, dtTimeCollected: new Date('2026-10-22T10:48:19.807Z') }, { CTFinalDumpingTonnageID: 21, dtEmpty: scenario === 'tie' ? time : new Date(+time + 3600000), dtTimeCollected: time }] };
    }
    if (statement.includes('SELECT TOP (1)')) {
      assert.match(statement, /CTFinalDumpingTonnageID = @CTFinalDumpingTonnageID AND dtDeletedAt IS NULL/);
      return { recordset: scenario === 'owned' ? [{ CTFinalLoadingTonnageID: 11, dtDeletedAt: null }] : [] };
    }
    return { recordset: [{ CTFinalDumpingTonnageID: scenario === 'wrong-result' ? 99 : 20 }] };
  };
  sql.Request.prototype.execute = async function (procedure) {
    executions++;
    assert.equal(procedure, 'dbo.sp_UpdateCTFinalDumpingTonnageIDManualByID');
    assert.deepEqual(Object.keys(this.parameters), ['CTFinalLoadingTonnageID']);
    assert.equal(this.parameters.CTFinalLoadingTonnageID.type, sql.Int);
    assert.equal(this.parameters.CTFinalLoadingTonnageID.value, 10);
    assert.equal(this.overrides.requestTimeout, 60000);
    if (scenario === 'sql-error') throw Error('sensitive');
    return {};
  };
  try {
    for (scenario of ['success', 'missing', 'linked', 'deleted', 'incomplete', 'no-candidate', 'no-time', 'tie', 'owned', 'deleted-owner', 'wrong-result', 'sql-error', 'commit-error']) {
      executions = commits = rollbacks = 0;
      if (['success', 'deleted-owner'].includes(scenario)) assert.match((await db.pairLoadingRelation(10)).message, /Kirim #10.*Terima #20/);
      else await assert.rejects(db.pairLoadingRelation(10), error => error.getStatus() === (scenario === 'missing' ? 404 : ['sql-error', 'commit-error'].includes(scenario) ? 503 : 409) && !error.message.includes('sensitive'));
      assert.equal(executions, ['success', 'deleted-owner', 'wrong-result', 'sql-error', 'commit-error'].includes(scenario) ? 1 : 0);
      assert.equal(commits, ['success', 'deleted-owner'].includes(scenario) ? 1 : 0);
      assert.equal(rollbacks, ['success', 'deleted-owner'].includes(scenario) ? 0 : 1);
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = originals[name];
    for (const name of ['query', 'execute']) sql.Request.prototype[name] = originals[name];
  }
});

test('Release relation locks row, clears reference once, and rolls back uncertain failures', async () => {
  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'test' });
  let scenario, commits, rollbacks;
  sql.Transaction.prototype.begin = async () => undefined;
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw new Error('sensitive commit error'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    if (statement.includes('SELECT TOP (1)')) {
      assert.match(statement, /UPDLOCK, HOLDLOCK/);
      assert.equal(this.parameters.CTFinalLoadingTonnageID.value, 2741276);
      return { recordset: scenario === 'missing' ? [] : [{ CTFinalDumpingTonnageID: scenario === 'unlinked' ? null : 3738119, CoalDeliveryNumber: 'AF26R000012' }] };
    }
    assert.match(statement, /SET CTFinalDumpingTonnageID = NULL/);
    assert.match(statement, /CTFinalDumpingTonnageID IS NOT NULL/);
    return { rowsAffected: [scenario === 'zero-rows' ? 0 : 1] };
  };
  try {
    for (scenario of ['success', 'missing', 'unlinked', 'zero-rows', 'commit-error']) {
      commits = rollbacks = 0;
      if (scenario === 'success') assert.match((await db.releaseLoadingRelation(2741276)).message, /Terima #3738119.*Kirim #2741276/);
      else await assert.rejects(db.releaseLoadingRelation(2741276), error => {
        assert.equal(error.getStatus(), ['missing'].includes(scenario) ? 404 : scenario === 'commit-error' ? 503 : 409);
        assert.ok(!error.message.includes('sensitive'));
        return true;
      });
      assert.equal(commits, scenario === 'success' ? 1 : 0);
      assert.equal(rollbacks, scenario === 'success' ? 0 : 1);
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = originals[name];
    sql.Request.prototype.query = originals.query;
  }
});

test('HTTP login, JWT protection, CRUD, lookup, read, upsert and friendly DB errors', async () => {
  const dir = await mkdtemp(join(tempRoot, 'http-test-'));
  process.env.APIS_FILE = join(dir, 'apis.json');
  validateEnvironment();
  const app = await createApp();
  const registry = app.get(PcRegistryService);
  let targets = [];
  registry.list = async () => structuredClone(targets);
  let nextTargetId = 1;
  registry.save = async (data, id = String(nextTargetId++)) => {
    const row = { ...data, id };
    const index = targets.findIndex(pc => pc.id === id);
    if (index < 0) targets.push(row); else targets[index] = row;
    return row;
  };
  registry.remove = async id => { await registry.get(id); targets = targets.filter(pc => pc.id !== id); return { message: 'Removed' }; };
  const authDb = app.get(AuthDbService);
  const hash = await passwordHash('test-only-password');
  const user = { id: 1, username: 'operator', displayName: 'Operator', tokenVersion: 1, roles: ['test'], permissions: ['equipment.view', 'equipment.ping', 'equipment.manage_pc', 'equipment.configure', 'monitoring.view', 'transactions.view', 'transactions.copy_loading', 'transactions.generate_receipt', 'transactions.delete', 'transactions.replay_raw', 'transactions.pair', 'transactions.unpair', 'timeline.view'] };
  authDb.credentials = async username => username === user.username ? { id: user.id, tokenVersion: user.tokenVersion, passwordHash: hash } : undefined;
  authDb.user = async id => id === user.id ? user : undefined;
  authDb.audit = async () => undefined;
  let token = '';
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = async (path, method = 'GET', body, auth = token) => {
      const response = await fetch(base + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await html.text(), /IT Dev Ops/);
    for (const [path, method] of [['/transactions/salin-muatan', 'POST'], ['/transactions/generate-sk-terima', 'POST'], ['/transactions/delete', 'POST'], ['/equipments?activeOnly=true', 'GET'], ['/transactions/raw-terima', 'POST'], ['/transactions/relations', 'POST'], ['/transactions/relations/pair', 'POST'], ['/transactions/relations?kind=Kirim&dumpingTonnageId=20', 'GET'], ['/transactions/timeline?coalDeliveryNumber=AF260080419', 'GET'], ['/apis', 'GET'], ['/apis', 'POST'], ['/apis/any', 'PUT'], ['/apis/any', 'DELETE'], ['/apis/ping', 'POST'], ['/equipments', 'GET'], ['/locations', 'GET'], ['/equipment-checks?apiId=x', 'GET'], ['/equipment-checks/location?apiId=x&equipmentId=1', 'GET'], ['/equipment-checks/upsert', 'POST']]) {
      assert.equal((await request(path, method, method === 'GET' || method === 'DELETE' ? undefined : {})).status, 401, path);
    }
    const bad = await request('/auth/login', 'POST', { username: 'operator', password: 'wrong' });
    assert.equal(bad.status, 401); assert.equal(bad.body.message, 'Username atau password salah');
    const login = await request('/auth/login', 'POST', { username: 'operator', password: 'test-only-password' });
    token = login.body.token;
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    assert.equal(claims.exp - claims.iat, 43200);
    assert.equal((await request('/apis', 'GET', undefined, token + 'broken')).status, 401);
    const expired = jwt.sign({}, process.env.JWT_SECRET, { expiresIn: -1, issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
    assert.equal((await request('/apis', 'GET', undefined, expired)).status, 401);
    assert.equal((await request('/auth/me')).body.userId, user.id);
    const loadUser = authDb.user;
    authDb.user = async () => ({ ...user, permissions: [] });
    assert.equal((await request('/apis')).status, 403);
    assert.equal((await request('/auth/me')).status, 200);
    authDb.user = async () => undefined; // Disabled users are absent from active-user lookup.
    assert.equal((await request('/apis')).status, 401);
    assert.equal((await request('/auth/login', 'POST', { username: 'operator', password: 'test-only-password' })).status, 401);
    authDb.user = async () => ({ ...user, tokenVersion: 2 });
    assert.equal((await request('/apis')).status, 401);
    assert.equal((await request('/auth/login', 'POST', { username: 'operator', password: 'test-only-password' })).status, 401);
    authDb.user = async () => { throw new (require('@nestjs/common').ServiceUnavailableException)('Database autentikasi tidak tersedia.'); };
    const unavailable = await request('/apis');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.message, 'Database autentikasi tidak tersedia.');
    authDb.user = loadUser;
    const credentials = authDb.credentials;
    authDb.credentials = async () => { throw new (require('@nestjs/common').ServiceUnavailableException)('Database autentikasi tidak tersedia.'); };
    assert.equal((await request('/auth/login', 'POST', { username: 'operator', password: 'test-only-password' })).status, 503);
    authDb.credentials = credentials;
    const db = app.get(DbService);
    const network = app.get(PcService);
    let replayCalls = 0;
    db.promoteRawDumping = async id => { replayCalls++; assert.equal(id, 19592476); return { message: 'Processed' }; };
    for (const body of [{}, { rawTonnageId: 19592476 }, { rawTonnageId: 19592476, confirmed: 'true' }, { coalDeliveryNumber: 'AF260080419', confirmed: true }, ...[null, '', '19592476', 0, -1, 1.5, 2147483648, [19592476]].map(rawTonnageId => ({ rawTonnageId, confirmed: true }))]) {
      assert.equal((await request('/transactions/raw-terima', 'POST', body)).status, 400);
    }
    assert.equal(replayCalls, 0);
    assert.equal((await request('/transactions/raw-terima', 'POST', { rawTonnageId: 19592476, confirmed: true })).status, 201);
    assert.equal(replayCalls, 1);
    let releaseCalls = 0;
    db.releaseLoadingRelation = async id => { releaseCalls++; assert.equal(id, 10); return { message: 'Released' }; };
    for (const body of [{}, { loadingTonnageId: 10 }, { loadingTonnageId: 10, confirmed: 'true' }, ...[0, -1, 1.2, '10', [10], null].map(loadingTonnageId => ({ loadingTonnageId, confirmed: true }))]) {
      assert.equal((await request('/transactions/relations', 'POST', body)).status, 400);
    }
    assert.equal(releaseCalls, 0);
    assert.equal((await request('/transactions/relations', 'POST', { loadingTonnageId: 10, confirmed: true })).status, 201);
    assert.equal(releaseCalls, 1);
    let pairCalls = 0;
    db.pairLoadingRelation = async id => { pairCalls++; assert.equal(id, 10); return { message: 'Paired' }; };
    for (const body of [{}, { loadingTonnageId: 10 }, { loadingTonnageId: 10, confirmed: 'true' }, ...[0, -1, 1.2, '10', [10], null, 2147483648].map(loadingTonnageId => ({ loadingTonnageId, confirmed: true }))]) {
      assert.equal((await request('/transactions/relations/pair', 'POST', body)).status, 400);
    }
    assert.equal(pairCalls, 0);
    assert.equal((await request('/transactions/relations/pair', 'POST', { loadingTonnageId: 10, confirmed: true })).status, 201);
    assert.equal(pairCalls, 1);
    let relationCalls = 0;
    db.relatedTransactions = async (kind, id) => { relationCalls++; assert.ok(['Kirim', 'Terima'].includes(kind)); assert.equal(id, 20); return [{ dtDeletedAt: '2026-01-01' }]; };
    for (const query of ['', '?kind=RawTerima&dumpingTonnageId=20', '?kind=Kirim', '?kind=Kirim&dumpingTonnageId=0', '?kind=Kirim&dumpingTonnageId=2147483648', '?kind=Kirim&dumpingTonnageId=abc']) assert.equal((await request('/transactions/relations' + query)).status, 400);
    assert.equal(relationCalls, 0);
    for (const kind of ['Kirim', 'Terima']) {
      const response = await request(`/transactions/relations?kind=${kind}&dumpingTonnageId=20`);
      assert.equal(response.status, 200);
      assert.equal(response.body[0].dtDeletedAt, '2026-01-01');
    }
    let timelineCalls = 0;
    db.truckTimeline = async coalDeliveryNumber => { timelineCalls++; return { coalDeliveryNumber, transactions: [{ Transaksi: 'RawDumping', IsValid: null }], activities: [{ trans: 'Net Reader', ReaderLocationName: 'MT 1' }] }; };
    for (const query of ['', '?coalDeliveryNumber=', '?coalDeliveryNumber=%20', '?coalDeliveryNumber=' + 'A'.repeat(51), '?coalDeliveryNumber=A%00B', '?coalDeliveryNumber=A&coalDeliveryNumber=B']) assert.equal((await request('/transactions/timeline' + query)).status, 400);
    assert.equal(timelineCalls, 0);
    const timeline = await request('/transactions/timeline?coalDeliveryNumber=%20AF260080419%20');
    assert.equal(timeline.status, 200); assert.equal(timeline.body.coalDeliveryNumber, 'AF260080419');
    assert.equal(timeline.body.transactions[0].IsValid, null); assert.equal(timeline.body.activities[0].ReaderLocationName, 'MT 1');
    db.truckTimeline = async () => { throw new (require('@nestjs/common').NotFoundException)('Data tidak ditemukan untuk CoalDeliveryNumber tersebut.'); };
    assert.equal((await request('/transactions/timeline?coalDeliveryNumber=UNKNOWN')).status, 404);
    const equipment = [{ EquipmentID: 10, strTruckCN: 'TR-10' }];
    const locations = [{ LocationID: 7, strLocationName: 'Lokasi 7' }, { LocationID: 8, strLocationName: 'Lokasi 8' }];
    db.equipments = async () => equipment;
    db.equipment = async id => equipment.filter(row => row.EquipmentID === id);
    db.locations = async () => locations;
    network.status = async pc => ({ ...pc, online: true, latency: 2, method: 'tcp' });
    network.requireTcp = async () => undefined;
    const invalid = await request('/apis', 'POST', { ...pc, locationIDs: [999] });
    assert.equal(invalid.status, 400); assert.match(invalid.body.message, /999/);
    const created = await request('/apis', 'POST', pc);
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await request('/apis')).body.length, 1);
    assert.equal((await request('/apis/ping', 'POST', { apiId: id })).body[0].method, 'tcp');
    assert.equal((await request(`/apis/${id}`, 'PUT', { ...pc, apiName: 'Updated PC' })).status, 200);
    assert.equal((await registry.list())[0].apiName, 'Updated PC');
    let probes = [];
    network.checks = async (_pc, params) => {
      if (!params) return [{ equipmentID: 10, locationID: 8, isGenerateCDN: false }];
      probes.push(params.locationID);
      return params.locationID === 8 ? [{ equipmentID: 10, locationID: 8, isGenerateCDN: false }] : [];
    };
    const lookup = await request(`/equipment-checks/location?apiId=${id}&equipmentId=10`);
    assert.equal(lookup.status, 200); assert.equal(lookup.body.locationID, 8); assert.deepEqual(probes, [7, 8]);
    assert.deepEqual(lookup.body.checkedLocationIDs, [7, 8]);
    const rows = await request(`/equipment-checks?apiId=${id}`);
    assert.equal(rows.body[0].equipmentName, 'TR-10'); assert.equal(rows.body[0].locationName, 'Lokasi 8');
    let writes = 0;
    network.checks = async () => assert.fail('Upsert must not GET EquipmentChecks');
    db.locations = async () => assert.fail('Upsert must not query locations');
    network.request = async (_pc, method, options) => {
      writes++; assert.equal(method, 'POST'); assert.equal(options.timeout, 10000);
      assert.deepEqual(options.data, { equipmentID: 10, locationID: 0, isGenerateCDN: false });
    };
    const payload = { apiId: id, equipmentID: 10, isGenerateCDN: false };
    for (const equipmentID of [999, null, '10', -1, 1.5]) {
      assert.equal((await request('/equipment-checks/upsert', 'POST', { ...payload, equipmentID })).status, 400);
    }
    assert.equal((await request('/equipment-checks/upsert', 'POST', { ...payload, isGenerateCDN: 'false' })).status, 400);
    assert.equal(writes, 0);
    for (const body of [payload, { ...payload, locationID: 0 }, { ...payload, locationID: 999 }]) {
      const response = await request('/equipment-checks/upsert', 'POST', body);
      assert.equal(response.status, 201);
      assert.match(response.body.message, /lokasi 0/);
    }
    assert.equal(writes, 3);
    db.locations = async () => locations;
    probes = [];
    network.checks = async (_pc, params) => { probes.push(params.locationID); throw new (require('@nestjs/common').BadGatewayException)('PC Updated PC (192.0.2.10) connection error'); };
    assert.equal((await request(`/equipment-checks/location?apiId=${id}&equipmentId=10`)).status, 502);
    assert.deepEqual(probes, [7]);
    network.requireTcp = async () => { throw new (require('@nestjs/common').ServiceUnavailableException)('PC Updated PC (192.0.2.10) offline'); };
    probes = [];
    assert.equal((await request(`/equipment-checks/location?apiId=${id}&equipmentId=10`)).status, 503); assert.deepEqual(probes, []);
    network.status = async pc => ({ ...pc, online: false, latency: null, method: null });
    assert.equal((await request(`/equipment-checks?apiId=${id}`)).status, 503);
    db.equipments = async () => { throw new (require('@nestjs/common').ServiceUnavailableException)('Database pusat tidak tersedia.'); };
    assert.equal((await request('/equipments')).status, 503);
    assert.equal((await request('/apis')).status, 200);
    assert.equal((await request(`/apis/${id}`, 'DELETE')).status, 200);
    assert.deepEqual(await registry.list(), []);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
