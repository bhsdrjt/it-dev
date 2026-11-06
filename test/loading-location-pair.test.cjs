const { test } = require('node:test');
const assert = require('node:assert/strict');
const sql = require('mssql');
const { DbService } = require('../dist/db');
const { loadingLocationToken } = require('../dist/loading-location');

test('Get LoadingLocation synchronizes referenced receipt atomically and rejects unsafe pairs', async () => {
  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const fields = { LoadingLocationID: 8, strStockPileName: 'PIT A', CoalQualityID: 3, CoalCalory: 4500, strCoalQualityName: 'SEAM A' };
  const source = { ...fields, strStockPileName: null, CTFinalLoadingTonnageID: 7, CTFinalDumpingTonnageID: 13, EquipmentID: 12, dtDeletedAt: null, dtEmpty: new Date('2026-11-05T08:00:00Z'), dtLoaded: new Date('2026-11-05T09:00:00Z'), CoalDeliveryNumber: 'SK-K' };
  const receipt = { ...fields, CoalCalory: 4000, CTFinalDumpingTonnageID: 13, EquipmentID: 12, dtDeletedAt: null, CoalDeliveryNumber: 'SK-T', flLoadedTonnage: 42000 };
  const candidate = { ...fields, readerAt: new Date('2026-11-05T08:50:00Z') };
  const token = loadingLocationToken(source, candidate, receipt);
  const db = new DbService(); db.connect = async () => new sql.ConnectionPool({ server: 'fixture' }); db.logger = { error() {} };
  let mode, k, d, commits, rollbacks, writes, audit, tx;
  sql.Transaction.prototype.begin = async function (level) { assert.equal(level, sql.ISOLATION_LEVEL.SERIALIZABLE); tx = this; };
  sql.Transaction.prototype.commit = async () => { commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; k = { ...source }; d = { ...receipt }; };
  sql.Request.prototype.query = async function (statement) {
    if (tx) assert.equal(this.parent, tx);
    if (statement.startsWith('INSERT ')) {
      audit = JSON.parse(this.parameters.target.value);
      if (mode === 'audit-fail') throw Error('denied');
      return { recordset: [] };
    }
    assert.equal(this.parameters.id.value, 7);
    if (statement.startsWith('DECLARE')) {
      writes++;
      assert.doesNotMatch(statement, /\bCoalQualityName\s*=/);
      if (statement.includes('UPDATE target')) {
        assert.match(statement, /cc\.CoalQualityName AS strCoalQualityName/);
        assert.match(statement, /strCoalQualityName = candidate\.strCoalQualityName/);
        k = { ...k, ...fields };
      } else {
        assert.match(statement, /strCoalQualityName = k\.strCoalQualityName/);
        assert.match(statement, /ON d.CTFinalDumpingTonnageID = k.CTFinalDumpingTonnageID/);
        assert.match(statement, /k.CTFinalLoadingTonnageID = @id AND d.dtDeletedAt IS NULL/);
        assert.doesNotMatch(statement, /CoalDeliveryNumber\s*=/);
        if (mode === 'receipt-sql-fail') throw Error('update failed');
        d = { ...d, ...fields };
        if (mode === 'receipt-trigger') d.flLoadedTonnage++;
        if (mode === 'source-trigger') k.EquipmentID++;
        if (mode === 'receipt-zero') return { recordset: [{ changed: 0 }] };
      }
      return { recordset: [{ changed: 1 }] };
    }
    if (statement.includes('FROM dbo.tabShiftNetReader')) return { recordset: [candidate] };
    if (statement.startsWith('SELECT d.*')) {
      if (tx) assert.match(statement, /UPDLOCK, HOLDLOCK/);
      return { recordset: mode === 'missing' ? [] : mode === 'ambiguous' ? [d, d] : [d] };
    }
    if (statement.startsWith('SELECT CTFinalLoadingTonnageID')) return { recordset: mode === 'shared' ? [{ CTFinalLoadingTonnageID: 7 }, { CTFinalLoadingTonnageID: 9 }] : [{ CTFinalLoadingTonnageID: 7 }] };
    return { recordset: [k] };
  };
  try {
    for (mode of ['success', 'missing', 'ambiguous', 'deleted', 'foreign-truck', 'missing-column', 'shared', 'stale-receipt', 'receipt-zero', 'receipt-sql-fail', 'receipt-trigger', 'source-trigger', 'audit-fail']) {
      k = { ...source }; d = { ...receipt }; commits = rollbacks = writes = 0; audit = null; tx = null;
      if (mode === 'deleted') d.dtDeletedAt = new Date();
      if (mode === 'foreign-truck') d.EquipmentID = 99;
      if (mode === 'missing-column') delete d.strCoalQualityName;
      if (mode === 'stale-receipt') d.CoalCalory++;
      if (mode === 'success') {
        const preview = await db.previewLoadingLocation(7);
        assert.deepEqual(preview.receipt, receipt); assert.equal(preview.previewToken, token);
        const result = await db.updateLoadingLocation(7, token, 19);
        assert.match(result.message, /Terima #13/); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(writes, 2);
        for (const key of Object.keys(fields)) { assert.equal(k[key], fields[key]); assert.equal(d[key], fields[key]); }
        assert.deepEqual(audit.receiptBefore, receipt); assert.deepEqual(audit.receiptAfter, d);
        assert.equal(d.CoalDeliveryNumber, 'SK-T'); assert.equal(k.CTFinalDumpingTonnageID, 13);
      } else {
        await assert.rejects(db.updateLoadingLocation(7, token, 19), e => e.getStatus() === (['receipt-sql-fail', 'audit-fail'].includes(mode) ? 503 : 409), mode);
        assert.equal(commits, 0, mode); assert.equal(rollbacks, 1, mode);
        assert.deepEqual(k, source); assert.deepEqual(d, receipt);
      }
    }
  } finally {
    for (const key of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[key] = originals[key];
    sql.Request.prototype.query = originals.query;
  }
});
