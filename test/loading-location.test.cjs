const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sql = require('mssql');
const { of, lastValueFrom } = require('rxjs');
const { Reflector } = require('@nestjs/core');
const { DbService } = require('../dist/db');
const { ApiController } = require('../dist/api');
const { JwtGuard, AuthAuditInterceptor } = require('../dist/auth');
const { loadingLocationToken, authDatabaseIdentifier } = require('../dist/loading-location');

const source = {
  CTFinalLoadingTonnageID: 7, CoalDeliveryNumber: 'SK-7', EquipmentID: 12,
  dtEmpty: new Date('2026-07-28T10:00:00Z'), dtLoaded: new Date('2026-07-28T11:00:00Z'),
  dtDeletedAt: null, CTFinalDumpingTonnageID: null, flEmptyTonnage: 10000, flLoadedTonnage: 40000,
  LoadingLocationID: null, strStockPileName: null, CoalQualityID: null, CoalCalory: null, strCoalQualityName: null,
};
const candidate = { LoadingLocationID: 41, strStockPileName: 'Stockpile α', CoalQualityID: 8, CoalCalory: 4321.125,
  strCoalQualityName: 'Coal α', readerAt: new Date('2026-07-28T10:30:00Z') };
const token = loadingLocationToken(source, candidate);
const body = { loadingTonnageId: 7, previewToken: token, confirmed: true };
const authRequest = { auth: { id: 19, userId: 19 } };

test('loading-location routes validate input, use authenticated actor, and enforce permission/guard metadata', () => {
  const api = new ApiController(null, null, { previewLoadingLocation: (...args) => args, updateLoadingLocation: (...args) => args });
  assert.deepEqual(api.previewLoadingLocation('7'), [7]);
  assert.deepEqual(api.updateLoadingLocation({ ...body, actorUserId: 999, candidate: { LoadingLocationID: 999 } }, authRequest), [7, token, 19]);
  for (const value of [undefined, null, '', '0', '-1', '1.2', '2147483648', '1 OR 1=1', ['7'], 7]) assert.throws(() => api.previewLoadingLocation(value), e => e.getStatus() === 400);
  for (const bad of [null, {}, ...[0, -1, 1.5, 2147483648, '7', true].map(loadingTonnageId => ({ ...body, loadingTonnageId })),
    ...[null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + token, 7].map(previewToken => ({ ...body, previewToken })),
    ...[undefined, false, 'true', 1].map(confirmed => ({ ...body, confirmed }))]) assert.throws(() => api.updateLoadingLocation(bad, authRequest), e => e.getStatus() === 400);
  const reflector = new Reflector();
  assert.ok(reflector.get('__guards__', ApiController).includes(JwtGuard));
  assert.ok(reflector.get('__interceptors__', ApiController).includes(AuthAuditInterceptor));
  for (const [name, method] of [['previewLoadingLocation', 0], ['updateLoadingLocation', 1]]) {
    assert.deepEqual(reflector.get('auth.permissions', api[name]), ['transactions.view']);
    assert.equal(reflector.get('path', api[name]), 'transactions/loading-location');
    assert.equal(reflector.get('method', api[name]), method);
  }
});

test('canonical snapshot and audit database identifier quoting', () => {
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(loadingLocationToken(Object.fromEntries(Object.entries(source).reverse()), candidate), token);
  assert.notEqual(loadingLocationToken({ ...source, flEmptyTonnage: 10001 }, candidate), token);
  const prior = process.env.AUTH_DB_DATABASE;
  try {
    delete process.env.AUTH_DB_DATABASE;
    assert.equal(authDatabaseIdentifier(), '[ITMonitor]');
    process.env.AUTH_DB_DATABASE = 'Other]Auth';
    assert.equal(authDatabaseIdentifier(), '[Other]]Auth]');
    for (const name of [' ', 'x'.repeat(129), 'bad\nname']) {
      process.env.AUTH_DB_DATABASE = name;
      assert.throws(authDatabaseIdentifier);
    }
  } finally { if (prior === undefined) delete process.env.AUTH_DB_DATABASE; else process.env.AUTH_DB_DATABASE = prior; }
});

test('preview and atomic update: authoritative query, locks, stale/duplicate rejection, audit and postcondition rollback', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const prior = process.env.AUTH_DB_DATABASE;
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  let mode, row, reader, pending, committedRow, statements, commits, rollbacks, audits, transaction, updated;
  const reset = (next = 'success') => {
    mode = next; row = { ...source }; reader = { ...candidate }; pending = undefined;
    committedRow = { ...source }; statements = []; commits = rollbacks = audits = updated = 0; transaction = undefined;
  };
  sql.Transaction.prototype.begin = async function (isolation) {
    assert.equal(isolation, sql.ISOLATION_LEVEL.SERIALIZABLE); transaction = this;
  };
  sql.Transaction.prototype.commit = async function () {
    assert.equal(this, transaction);
    if (mode === 'commit-error') throw Error('private SQL error');
    assert.equal(audits, 1); commits++; committedRow = pending;
  };
  sql.Transaction.prototype.rollback = async function () {
    assert.equal(this, transaction); rollbacks++; pending = undefined;
    if (mode === 'rollback-error') throw Error('private rollback error');
  };
  sql.Request.prototype.query = async function (statement) {
    statements.push(statement);
    if (transaction) assert.equal(this.parent, transaction);
    if (statement.startsWith('INSERT ')) {
      assert.match(statement, /INSERT \[Other\]\]Auth\]\.dbo\.UserAudit\(ActorUserId,Action,Target,OperationId,Outcome\)/);
      assert.equal(this.parameters.actor.value, 19);
      assert.equal(this.parameters.action.value, 'loading_location.update');
      assert.equal(this.parameters.outcome.value, 'succeeded');
      assert.match(this.parameters.operation.value, /^[a-f0-9]{32}$/);
      assert.deepEqual(JSON.parse(this.parameters.target.value), JSON.parse(JSON.stringify({ loadingTonnageId: 7, before: row, after: pending, receiptBefore: null, receiptAfter: null, readerAt: candidate.readerAt })));
      assert.equal(commits, 0); audits++;
      if (mode === 'audit-error') throw Error('private INSERT denied');
      return { recordset: [] };
    }
    assert.equal(this.parameters.id.value, 7);
    assert.equal(this.parameters.id.type, sql.Int);
    assert.deepEqual(Object.keys(this.parameters), ['id']);
    if (statement.startsWith('DECLARE')) {
      updated++;
      assert.match(statement, /OUTPUT inserted\.CTFinalLoadingTonnageID INTO @changed/);
      assert.match(statement, /COUNT\(\*\) AS changed FROM @changed/);
      assert.match(statement, /target\.CTFinalLoadingTonnageID = @id AND target\.dtDeletedAt IS NULL AND target\.strStockPileName IS NULL/);
      assert.match(statement, /WITH candidate AS \(SELECT TOP \(1\) WITH TIES/);
      assert.doesNotMatch(statement, /SET[^;]*(?:dtUpdatedAt|flEmptyTonnage)\s*=/);
      const { readerAt, ...fields } = reader;
      pending = { ...row, ...fields };
      if (mode.startsWith('protected:')) pending[mode.slice(10)] = 'changed by trigger';
      if (mode === 'wrong-location') pending.LoadingLocationID = 42;
      if (mode === 'rollback-error') return { recordset: [{ changed: 0 }] };
      return { recordset: [{ changed: mode === 'no-update' ? 0 : 1 }], rowsAffected: [999] };
    }
    if (statement.includes('FROM dbo.tabShiftNetReader')) {
      assert.match(statement, /TOP \(1\) WITH TIES/);
      assert.match(statement, /LEFT JOIN dbo\.tabRFIDReader rr/);
      assert.match(statement, /LEFT JOIN dbo\.tabLocation l/);
      assert.match(statement, /LEFT JOIN dbo\.tabCoalQualityAGM cc.*ON cc\.CoalQualityID = rr\.CoalQualityID/);
      assert.match(statement, /rr\.CoalQualityID, cc\.Coalcalory AS CoalCalory, cc\.CoalQualityName AS strCoalQualityName/);
      assert.doesNotMatch(statement, /tabEnum|rr\.CoalCalory|te\.strName/);
      assert.match(statement, /nr\.EquipmentID = source\.EquipmentID AND nr\.dtcreatedAt BETWEEN source\.dtEmpty AND source\.dtLoaded/);
      assert.match(statement, /ORDER BY nr\.dtcreatedAt DESC$/);
      assert.doesNotMatch(statement, /IS NOT NULL|NOLOCK/);
      assert.equal((statement.match(/WITH \(UPDLOCK, HOLDLOCK\)/g) || []).length, transaction ? 5 : 0);
      if (mode === 'no-reader') return { recordset: [] };
      if (mode === 'tied') return { recordset: [reader, { ...reader }] };
      return { recordset: [reader] };
    }
    assert.match(statement, /SELECT \* FROM dbo\.tabCTFinalLoadingTonnage/);
    assert.match(statement, /CTFinalLoadingTonnageID = @id AND dtDeletedAt IS NULL/);
    if (transaction) assert.match(statement, /WITH \(UPDLOCK, HOLDLOCK\)/);
    if (mode === 'missing' || mode === 'deleted' || (updated && mode === 'disappeared')) return { recordset: [] };
    if (mode === 'duplicate-source') return { recordset: [row, row] };
    return { recordset: [pending || row] };
  };
  try {
    process.env.AUTH_DB_DATABASE = 'Other]Auth';
    reset();
    const preview = await db.previewLoadingLocation(7);
    assert.deepEqual(preview.source, source); assert.deepEqual(preview.candidate, candidate); assert.equal(preview.previewToken, token);
    assert.equal(preview.queries.length, 2); assert.equal(commits, 0); assert.equal(updated, 0);
    for (const scenario of ['missing', 'deleted', 'duplicate-source', 'no-reader', 'tied', 'already-set', 'zero-name', 'undefined-name', 'blank-name', 'invalid-time', 'no-equipment',
      ...Object.keys(candidate).map(key => `null:${key}`), 'empty-name', 'bad-calory']) {
      for (const post of [false, true]) {
        reset(scenario);
        if (scenario === 'already-set') row.strStockPileName = 'Existing stockpile';
        if (scenario === 'zero-name') row.strStockPileName = 0;
        if (scenario === 'undefined-name') delete row.strStockPileName;
        if (scenario === 'blank-name') row.strStockPileName = '';
        if (scenario === 'invalid-time') row.dtEmpty = new Date('2027-01-01');
        if (scenario === 'no-equipment') row.EquipmentID = null;
        if (scenario.startsWith('null:')) reader[scenario.slice(5)] = null;
        if (scenario === 'empty-name') reader.strCoalQualityName = ' ';
        if (scenario === 'bad-calory') reader.CoalCalory = NaN;
        await assert.rejects(post ? db.updateLoadingLocation(7, token, 19) : db.previewLoadingLocation(7), e => e.getStatus() === (['missing', 'deleted', 'no-reader'].includes(scenario) ? 404 : 409));
        assert.equal(updated, 0); assert.equal(commits, 0); assert.equal(rollbacks, post ? 1 : 0);
      }
    }
    for (const change of ['source', 'candidate', 'token']) {
      reset();
      if (change === 'source') row.CoalDeliveryNumber = 'SK-changed';
      if (change === 'candidate') reader.CoalCalory++;
      await assert.rejects(db.updateLoadingLocation(7, change === 'token' ? '0'.repeat(64) : token, 19), e => e.getStatus() === 409);
      assert.equal(updated, 0); assert.equal(rollbacks, 1);
    }
    for (const scenario of ['no-update', 'disappeared', 'wrong-location', 'audit-error', 'commit-error', 'rollback-error',
      ...['EquipmentID', 'CoalDeliveryNumber', 'flEmptyTonnage', 'flLoadedTonnage', 'dtEmpty', 'dtLoaded', 'CTFinalDumpingTonnageID'].map(key => `protected:${key}`)]) {
      reset(scenario);
      await assert.rejects(db.updateLoadingLocation(7, token, 19), e => e.getStatus() === (['audit-error', 'commit-error', 'rollback-error'].includes(scenario) ? 503 : 409) && !e.message.includes('private'));
      assert.equal(commits, 0); assert.equal(rollbacks, 1); assert.deepEqual(committedRow, source);
      assert.equal(audits, ['audit-error', 'commit-error'].includes(scenario) ? 1 : 0);
    }
    reset();
    const result = await db.updateLoadingLocation(7, token.toUpperCase(), 19);
    assert.match(result.message, /Kirim #7/); assert.equal(result.queries.length, 5);
    assert.equal(updated, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(audits, 1);
    const applied = committedRow;
    reset(); row = applied; committedRow = applied;
    await assert.rejects(db.updateLoadingLocation(7, token, 19), e => e.getStatus() === 409);
    assert.equal(updated, 0); assert.equal(audits, 0); assert.equal(rollbacks, 1);
  } finally {
    for (const key of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[key] = original[key];
    sql.Request.prototype.query = original.query;
    if (prior === undefined) delete process.env.AUTH_DB_DATABASE; else process.env.AUTH_DB_DATABASE = prior;
  }
});

test('existing audit interceptor includes loadingTonnageId query and preserves uncertain completion status', async () => {
  const entries = [];
  const request = { ...authRequest, method: 'GET', path: '/transactions/loading-location', query: { loadingTonnageId: '7', previewToken: token, secret: 'private' } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  const interceptor = new AuthAuditInterceptor({ audit: async (...args) => entries.push(args) });
  await lastValueFrom(interceptor.intercept(context, { handle: () => of({}) }));
  assert.deepEqual(JSON.parse(entries[0][2]).query, { loadingTonnageId: '7' });
  assert.equal(entries[0][4], 'started'); assert.equal(entries[1][4], 'succeeded');
  request.method = 'POST'; request.body = body;
  const uncertain = new AuthAuditInterceptor({ audit: async (...args) => { if (args[4] === 'succeeded') throw Error('private'); } });
  await assert.rejects(lastValueFrom(uncertain.intercept(context, { handle: () => of({}) })), e => e.getStatus() === 503);
});
