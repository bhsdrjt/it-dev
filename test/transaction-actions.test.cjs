const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sql = require('mssql');
const { DbService } = require('../dist/db');
const { ApiController } = require('../dist/api');

test('transaction action validation and active equipment filter', async () => {
  const api = new ApiController(null, null, { salinMuatan: (...args) => args, salinMuatanKeTerimaAda: (...args) => args, salinMuatanCandidates: (...args) => args, generateSkTerima: cdn => cdn, deleteTransaction: (...args) => args, equipments: active => active });
  assert.deepEqual(api.salinMuatan({ coalDeliveryNumber: ' CDN ', nextDT: ' TR10061 ', confirmed: true }), ['CDN', 'TR10061']);
  assert.deepEqual(api.salinMuatanKeTerimaAda({ coalDeliveryNumber: ' CDN ', nextDT: ' TR10061 ', ctFinalDumpingTonnageId: 42, confirmed: true }), ['CDN', 'TR10061', 42]);
  for (const body of [null, { coalDeliveryNumber: 'CDN', nextDT: 'X'.repeat(9), ctFinalDumpingTonnageId: 42, confirmed: true }, { coalDeliveryNumber: 'CDN', nextDT: 'TR10061', ctFinalDumpingTonnageId: 0, confirmed: true }, { coalDeliveryNumber: 'CDN', nextDT: 'TR10061', ctFinalDumpingTonnageId: 1.5, confirmed: true }, { coalDeliveryNumber: 'CDN', nextDT: 'TR10061', ctFinalDumpingTonnageId: 42 }, { coalDeliveryNumber: 'CDN', nextDT: 'TR10061', ctFinalDumpingTonnageId: '42', confirmed: true }]) assert.throws(() => api.salinMuatanKeTerimaAda(body), e => e.getStatus() === 400);
  assert.deepEqual(api.salinMuatanCandidates(' CDN ', ' TR10061 '), ['CDN', 'TR10061']);
  for (const [cdn, truck] of [['X'.repeat(21), 'TR'], ['CDN', 'X'.repeat(9)], ['C\nD', 'TR'], ['CDN', 'T\nR']]) assert.throws(() => api.salinMuatanCandidates(cdn, truck), e => e.getStatus() === 400);
  assert.equal(api.generateSkTerima({ coalDeliveryNumber: ' CDN ', confirmed: true }), 'CDN');
  for (const body of [null, {}, { coalDeliveryNumber: 'CDN' }, { coalDeliveryNumber: 'X'.repeat(21), confirmed: true }, { coalDeliveryNumber: 'C\nD', confirmed: true }]) assert.throws(() => api.generateSkTerima(body), e => e.getStatus() === 400);
  for (const body of [null, {}, { coalDeliveryNumber: 'X'.repeat(21), nextDT: 'TR', confirmed: true }, { coalDeliveryNumber: 'CDN', nextDT: 'X'.repeat(9), confirmed: true }, { coalDeliveryNumber: 'CDN', nextDT: 'TR' }, { coalDeliveryNumber: 'CDN', nextDT: 'T\nR', confirmed: true }]) assert.throws(() => api.salinMuatan(body), e => e.getStatus() === 400);
  for (const kind of ['Kirim', 'Terima']) assert.deepEqual(api.deleteTransaction({ kind, tonnageId: 7, confirmed: true }), [kind, 7]);
  for (const body of [{ kind: 'TerimaRaw', tonnageId: 7, confirmed: true }, ...[0, -1, 1.5, 2147483648, '7'].map(tonnageId => ({ kind: 'Kirim', tonnageId, confirmed: true })), { kind: 'Kirim', tonnageId: 7 }]) assert.throws(() => api.deleteTransaction(body), e => e.getStatus() === 400);
  assert.equal(api.equipments('true'), true);
  assert.equal(api.equipments(), false);
  assert.throws(() => api.equipments('anything'));
  const db = new DbService();
  db.query = async statement => statement;
  assert.match(await db.equipments(true), /WHERE dtDeletedAt IS NULL/);
  assert.doesNotMatch(await db.equipments(), /WHERE/);
});

test('generate SK Terima mirrors usp_DataHilang candidates, verifies one new receipt, rolls back failures', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query, execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  const time = new Date('2026-07-28T10:00:00Z');
  const other = new Date('2026-07-28T11:00:00Z');
  let scenario, commits, rollbacks, executed;
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw Error('private'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.execute = async function (name) {
    executed++;
    assert.equal(name, 'dbo.usp_DataHilang');
    assert.equal(this.parameters.CoalDeliveryNumberNya.value, 'CDN');
    assert.equal(this.parameters.CoalDeliveryNumberNya.length, 20);
    assert.equal(this.overrides.requestTimeout, 60000);
    if (scenario === 'sql-error') throw Error('private');
    if (scenario === '50003') throw Object.assign(Error('private'), { number: 50003 });
    return {};
  };
  sql.Request.prototype.query = async function (statement) {
    assert.equal(this.parameters.cdn.value, 'CDN');
    if (statement.includes('FROM dbo.tabCTFinalLoadingTonnage')) return { recordset: scenario === 'missing' ? [] : [{ EquipmentID: 7, dtLoaded: scenario === 'no-time' ? null : time }] };
    if (statement.includes('FROM dbo.tabCTDumpLoaded')) return { recordset: scenario === 'no-loaded' ? [] : [{ dtTimeCollected: time }] };
    if (statement.includes('FROM dbo.tabCTDumpEmpty')) return { recordset: scenario === 'missing-empty' ? [] : [{ dtTimeCollected: time }] };
    if (statement.includes('WITH (UPDLOCK, HOLDLOCK)')) return { recordset: [{ CTFinalDumpingTonnageID: 1 }] };
    // Hasil akhir setelah exec.
    const created = { CTFinalDumpingTonnageID: 42, EquipmentID: 7, dtEmpty: scenario === 'wrong-time' ? other : time, dtDeletedAt: null };
    return { recordset: scenario === 'no-new' ? [{ CTFinalDumpingTonnageID: 1 }] : scenario === 'wrong-equipment' ? [{ ...created, EquipmentID: 8 }] : [created] };
  };
  try {
    for (scenario of ['success', 'missing', 'no-time', 'no-loaded', 'missing-empty', 'no-new', 'wrong-equipment', 'wrong-time', 'sql-error', '50003', 'commit-error']) {
      commits = rollbacks = executed = 0;
      const call = () => db.generateSkTerima('CDN');
      if (['success', 'no-loaded'].includes(scenario)) assert.match((await call()).message, /Terima #42/);
      else await assert.rejects(call(), e => e.getStatus() === (['missing', 'no-time'].includes(scenario) ? 404 : ['sql-error', 'commit-error'].includes(scenario) ? 503 : 409));
      assert.equal(commits, ['success', 'no-loaded'].includes(scenario) ? 1 : 0);
      assert.equal(rollbacks, ['success', 'no-loaded'].includes(scenario) ? 0 : 1);
      assert.equal(executed, ['missing', 'no-time', 'missing-empty'].includes(scenario) ? 0 : 1);
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    for (const name of ['query', 'execute']) sql.Request.prototype[name] = original[name];
  }
});

test('mutations return executed queries with bound values for the activity log', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query, execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => {};
  sql.Transaction.prototype.rollback = async () => {};
  let step = 0;
  sql.Request.prototype.query = async function () {
    assert.equal(this.parameters.id.value, 7);
    step++;
    if (step === 1) return { recordset: [{ dtDeletedAt: null }] };
    if (step === 2) return { recordset: [{ changed: 1 }] };
    return { recordset: [{ dtDeletedAt: new Date() }] };
  };
  try {
    const result = await db.deleteTransaction('Kirim', 7);
    assert.match(result.message, /ditandai dihapus/);
    assert.equal(result.queries.length, 3);
    assert.match(result.queries[0], /WHERE CTFinalLoadingTonnageID = 7$/);
    assert.match(result.queries[1], /UPDATE dbo\.tabCTFinalLoadingTonnage/);
    assert.doesNotMatch(result.queries[1], /@id/);
    sql.Request.prototype.query = async () => ({ recordset: [] });
    await assert.rejects(db.deleteTransaction('Kirim', 9), error => {
      assert.equal(error.getStatus(), 404);
      assert.match(error.getResponse().queries[0], /CTFinalLoadingTonnageID = 9/);
      return true;
    });
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    for (const name of ['query', 'execute']) sql.Request.prototype[name] = original[name];
  }
});

test('restore Transaction clears dtDeletedAt and sets dtUpdatedAt', async () => {
  const original = {
    begin: sql.Transaction.prototype.begin,
    commit: sql.Transaction.prototype.commit,
    rollback: sql.Transaction.prototype.rollback,
    query: sql.Request.prototype.query,
  };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {}, log() {} };
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => {};
  sql.Transaction.prototype.rollback = async () => {};
  let step = 0;
  sql.Request.prototype.query = async function () {
    assert.equal(this.parameters.id.value, 7);
    step++;
    if (step === 1) return { recordset: [{ dtDeletedAt: new Date() }] };
    if (step === 2) return { recordset: [{ changed: 1 }] };
    return { recordset: [{ dtDeletedAt: null }] };
  };
  try {
    const result = await db.restoreTransaction('Terima', 7);
    assert.match(result.message, /dipulihkan/);
    assert.equal(result.queries.length, 3);
    assert.match(result.queries[1], /UPDATE dbo\.tabCTFinalDumpingTonnage SET dtDeletedAt = NULL, dtUpdatedAt = GETDATE\(\)/);
    assert.match(result.queries[1], /WHERE CTFinalDumpingTonnageID = 7 AND dtDeletedAt IS NOT NULL/);
    // Baris aktif tidak bisa dipulihkan.
    sql.Request.prototype.query = async () => ({ recordset: [{ dtDeletedAt: null }] });
    await assert.rejects(db.restoreTransaction('Terima', 7), error => error.getStatus() === 409);
    // Baris tidak ada.
    sql.Request.prototype.query = async () => ({ recordset: [] });
    await assert.rejects(db.restoreTransaction('Kirim', 7), error => error.getStatus() === 404);
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    sql.Request.prototype.query = original.query;
  }
});

test('restore endpoint validates kind, id, and confirmation', async () => {
  const api = new ApiController(null, null, { restoreTransaction: (...args) => args });
  assert.deepEqual(api.restoreTransaction({ kind: 'Kirim', tonnageId: 7, confirmed: true }), ['Kirim', 7]);
  for (const body of [{ kind: 'TerimaRaw', tonnageId: 7, confirmed: true }, { kind: 'Kirim', tonnageId: 7 }, { kind: 'Kirim', tonnageId: 7, confirmed: false }, ...[0, -1, 1.5, '7'].map(tonnageId => ({ kind: 'Kirim', tonnageId, confirmed: true }))]) assert.throws(() => api.restoreTransaction(body), e => e.getStatus() === 400);
});

test('salin Muatan delegates to usp_SalinMuatan and maps procedure errors', async () => {  const original = { execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  let scenario, calls;
  sql.Request.prototype.execute = async function (name) {
    calls++;
    assert.equal(name, 'dbo.usp_SalinMuatan');
    assert.equal(this.parameters.CoalDeliveryNumberNya.value, 'CDN');
    assert.equal(this.parameters.CoalDeliveryNumberNya.length, 20);
    assert.equal(this.parameters.nextDT.value, 'TR10061');
    assert.equal(this.parameters.nextDT.length, 8);
    assert.equal(this.overrides.requestTimeout, 60000);
    if (typeof scenario === 'number') throw Object.assign(Error('private'), { number: scenario });
    if (scenario === 'sql-error') throw Error('private');
    return {};
  };
  try {
    for (const [code, status] of [[50001, 404], [50002, 404], [50003, 409], [50004, 409]]) {
      scenario = code; calls = 0;
      await assert.rejects(db.salinMuatan('CDN', 'TR10061'), error => {
        assert.equal(error.getStatus(), status);
        assert.match(error.getResponse().queries[0], /^EXEC dbo\.usp_SalinMuatan @CoalDeliveryNumberNya = 'CDN', @nextDT = 'TR10061'$/);
        return true;
      });
      assert.equal(calls, 1);
    }
    scenario = 'sql-error'; calls = 0;
    await assert.rejects(db.salinMuatan('CDN', 'TR10061'), error => error.getStatus() === 503 && !error.message.includes('private'));
    assert.equal(calls, 1);
    scenario = 'success'; calls = 0;
    const result = await db.salinMuatan('CDN', 'TR10061');
    assert.equal(calls, 1);
    assert.match(result.message, /dbo\.usp_SalinMuatan/);
    assert.deepEqual(result.queries, [`EXEC dbo.usp_SalinMuatan @CoalDeliveryNumberNya = 'CDN', @nextDT = 'TR10061'`]);
  } finally {
    sql.Request.prototype.execute = original.execute;
  }
});

test('salin Muatan candidates list unpaired receipt for the target truck', async () => {
  const original = { query: sql.Request.prototype.query };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  const time = new Date('2026-07-28T10:00:00Z');
  let scenario, statements;
  sql.Request.prototype.query = async function (statement) {
    statements++;
    if (statements === 1) {
      assert.equal(this.parameters.cdn.value, 'CDN');
      assert.equal(this.parameters.cdn.length, 20);
      assert.match(statement, /ORDER BY dtLoaded DESC/);
      return { recordset: scenario === 'no-source' ? [] : [{ EquipmentID: 7, dtLoaded: scenario === 'no-time' ? null : time }] };
    }
    if (statements === 2) {
      assert.equal(this.parameters.nextDT.value, 'TR10061');
      assert.equal(this.parameters.nextDT.length, 8);
      return { recordset: scenario === 'no-truck' ? [] : [{ EquipmentID: 9 }] };
    }
    if (statements === 3) {
      assert.equal(this.parameters.eq.value, 9);
      assert.equal(this.parameters.dtLoaded.value, time);
      assert.match(statement, /d\.dtEmpty >= @dtLoaded/);
      assert.match(statement, /d\.dtEmpty <= DATEADD\(DAY, 3, @dtLoaded\)/);
      assert.match(statement, /d\.dtDeletedAt IS NULL/);
      assert.match(statement, /DATEADD\(DAY, 3, d\.dtEmpty\)/);
      assert.match(statement, /ORDER BY d\.dtEmpty ASC/);
      assert.match(statement, /TOP \(1\)/);
      assert.match(statement, /WITH \(NOLOCK\)/);
      assert.doesNotMatch(statement, /NOT IN/);
      return { recordset: scenario === 'no-candidate' ? [] : [{ CTFinalDumpingTonnageID: 42, CoalDeliveryNumber: 'SK-TUJUAN', dtLoaded: time, dtEmpty: time }] };
    }
    if (statements === 4) {
      assert.equal(this.parameters.eq.value, 9);
      assert.match(statement, /dbo\.tabCTDumpEmpty/);
      assert.match(statement, /DATEADD\(DAY, 4, @dtLoaded\)/);
      assert.match(statement, /f\.dtEmpty = d\.dtTimeCollected/);
      return { recordset: [{ dtEmpty: time, flEmptyTonnage: 0 }] };
    }
    assert.equal(this.parameters.previewEmpty.value, time);
    assert.match(statement, /dbo\.tabCTDumpLoaded/);
    assert.match(statement, /d\.dtTimeCollected <= @previewEmpty/);
    return { recordset: [{ dtLoaded: time, flLoadedTonnage: 32000 }] };
  };
  try {
    for (const [mode, status] of [['no-source', 404], ['no-time', 404], ['no-truck', 404]]) {
      scenario = mode; statements = 0;
      await assert.rejects(db.salinMuatanCandidates('CDN', 'TR10061'), error => error.getStatus() === status);
    }
    scenario = 'success'; statements = 0;
    const result = await db.salinMuatanCandidates('CDN', 'TR10061');
    assert.equal(statements, 3);
    assert.equal(result.nextDT, 'TR10061');
    assert.equal(result.preview, null);
    assert.deepEqual(result.candidates.map(row => row.CTFinalDumpingTonnageID), [42]);
    // Tanpa kandidat: pratinjau Terima baru diambil dari timbang kosong/muat berikutnya.
    scenario = 'no-candidate'; statements = 0;
    const fallback = await db.salinMuatanCandidates('CDN', 'TR10061');
    assert.equal(statements, 5);
    assert.deepEqual(fallback.candidates, []);
    assert.equal(fallback.preview.dtEmpty, time);
    assert.equal(fallback.preview.dtLoaded, time);
    assert.equal(fallback.preview.flLoadedTonnage, 32000);
  } finally {
    sql.Request.prototype.query = original.query;
  }
});

test('salin Muatan ke SK terima ada delegates to usp_SalinMuatanKeTerimaAda and maps procedure errors', async () => {
  const original = { execute: sql.Request.prototype.execute };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {}, log() {} };
  let scenario, calls;
  sql.Request.prototype.execute = async function (name) {
    calls++;
    assert.equal(name, 'dbo.usp_SalinMuatanKeTerimaAda');
    assert.equal(this.parameters.CoalDeliveryNumberNya.value, 'CDN');
    assert.equal(this.parameters.CoalDeliveryNumberNya.length, 20);
    assert.equal(this.parameters.NoTruck.value, 'TR10061');
    assert.equal(this.parameters.NoTruck.length, 8);
    assert.equal(this.parameters.CTFinalDumpingTonnageID.value, 42);
    assert.equal(this.overrides.requestTimeout, 60000);
    if (typeof scenario === 'number') throw Object.assign(Error('private'), { number: scenario });
    if (scenario === 'sql-error') throw Error('private');
    return { recordset: [{ Pesan: 'Salin muatan berhasil. Kirim #7 dipasangkan dengan Terima #42 (truck TR10061).' }] };
  };
  try {
    for (const [code, status] of [[50010, 404], [50011, 404], [50012, 404], [50013, 409], [50017, 409]]) {
      scenario = code; calls = 0;
      await assert.rejects(db.salinMuatanKeTerimaAda('CDN', 'TR10061', 42), error => {
        assert.equal(error.getStatus(), status);
        assert.match(error.getResponse().queries[0], /^EXEC dbo\.usp_SalinMuatanKeTerimaAda @CoalDeliveryNumberNya = 'CDN', @NoTruck = 'TR10061', @CTFinalDumpingTonnageID = 42$/);
        return true;
      });
      assert.equal(calls, 1);
    }
    scenario = 'sql-error'; calls = 0;
    await assert.rejects(db.salinMuatanKeTerimaAda('CDN', 'TR10061', 42), error => error.getStatus() === 503 && !error.message.includes('private'));
    assert.equal(calls, 1);
    scenario = 'success'; calls = 0;
    const result = await db.salinMuatanKeTerimaAda('CDN', 'TR10061', 42);
    assert.equal(calls, 1);
    assert.match(result.message, /Terima #42/);
  } finally {
    sql.Request.prototype.execute = original.execute;
  }
});

test('soft-delete binds parameters, verifies writes, rollback failures', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {} };
  const time = new Date('2026-07-28T10:00:00Z');
  let scenario, mode, commits, rollbacks, queries;
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw Error('private'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    queries++;
    assert.equal(this.parameters.id.value, 7);
    assert.match(statement, new RegExp(mode === 'Kirim' ? 'tabCTFinalLoadingTonnage' : 'tabCTFinalDumpingTonnage'));
    if (queries === 1) return { recordset: scenario === 'missing' ? [] : [{ dtDeletedAt: scenario === 'deleted' ? time : null }] };
    if (queries === 2) {
      assert.match(statement, /SET dtDeletedAt = GETDATE\(\)/);
      assert.match(statement, /OUTPUT inserted\./);
      assert.match(statement, /AND dtDeletedAt IS NULL/);
      return { recordset: [{ changed: scenario === 'no-write' ? 0 : 1 }] };
    }
    return { recordset: [{ dtDeletedAt: scenario === 'no-status' ? null : time }] };
  };
  try {
    for (mode of ['Kirim', 'Terima']) {
      for (scenario of ['success', 'missing', 'deleted', 'no-write', 'no-status', 'commit-error']) {
        commits = rollbacks = queries = 0;
        const call = () => db.deleteTransaction(mode, 7);
        if (scenario === 'success') assert.match((await call()).message, /ditandai dihapus/);
        else await assert.rejects(call(), e => e.getStatus() === (scenario === 'missing' ? 404 : ['commit-error'].includes(scenario) ? 503 : 409));
        assert.equal(commits, scenario === 'success' ? 1 : 0);
        assert.equal(rollbacks, scenario === 'success' ? 0 : 1);
      }
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    sql.Request.prototype.query = original.query;
  }
});
