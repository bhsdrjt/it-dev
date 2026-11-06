const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sql = require('mssql');
const { DbService } = require('../dist/db');
const { ApiController } = require('../dist/api');

test('detail validates kind/ID, permits existing view permissions, selects final table by ID including deleted rows', async () => {
  const api = new ApiController(null, null, { transactionDetail: (...args) => args });
  assert.deepEqual(Reflect.getMetadata('auth.permissions', api.transactionDetail), ['transactions.view', 'timeline.view']);
  assert.deepEqual(api.transactionDetail('Kirim', '7'), ['Kirim', 7]);
  for (const kind of ['Loading', 'RawTerima', '', "Kirim'; DROP TABLE x", null]) assert.throws(() => api.transactionDetail(kind, '7'), e => e.getStatus() === 400);
  for (const id of ['0', '-1', '1.2', '2147483648', '1 OR 1=1', null]) assert.throws(() => api.transactionDetail('Terima', id), e => e.getStatus() === 400);
  const db = new DbService();
  let rows = [{ CTFinalLoadingTonnageID: 7, dtDeletedAt: '2026-11-01', field: null, zero: 0, flag: false }];
  let statement;
  db.read = async action => action({ input(name, type, value) { assert.equal(name, 'id'); assert.equal(type, sql.Int); assert.equal(value, 7); return this; }, async query(text) { statement = text; return { recordset: rows }; } });
  assert.deepEqual(await db.transactionDetail('Kirim', 7), rows[0]);
  assert.equal(statement, 'SELECT * FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalLoadingTonnageID = @id');
  await db.transactionDetail('Terima', 7);
  assert.equal(statement, 'SELECT * FROM dbo.tabCTFinalDumpingTonnage WHERE CTFinalDumpingTonnageID = @id');
  rows = []; await assert.rejects(db.transactionDetail('Kirim', 7), e => e.getStatus() === 404);
  rows = [{}, {}]; await assert.rejects(db.transactionDetail('Terima', 7), e => e.getStatus() === 409);
});
