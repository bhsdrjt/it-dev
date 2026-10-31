const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sql = require('mssql');
const { ApiController } = require('../dist/api');
const { DbService } = require('../dist/db');

test('truck history validates ID, real calendar dates and range without timezone conversion', () => {
  const api = new ApiController(null, null, { truckHistory: (...args) => args });
  const args = api.truckHistory('333', '2026-04-01 06:00:00', '2026-04-02T23:00');
  assert.equal(args[0], 333);
  assert.equal(args[1].toISOString(), '2026-04-01T06:00:00.000Z');
  assert.equal(args[2].toISOString(), '2026-04-02T23:00:00.000Z');
  for (const id of [undefined, [], '0', '-1', '1.5', '2147483648', '333; DROP TABLE x']) assert.throws(() => api.truckHistory(id, '2026-04-01T06:00', '2026-04-02T23:00'), error => error.getStatus() === 400);
  for (const date of [undefined, [], '', '2026-02-29T06:00', '2026-04-31T06:00', '2026-04-01T24:00', '1752-12-31T23:59', '2026-04-01T06:00:00Z', '2026-04-01T06:00:00+07:00']) assert.throws(() => api.truckHistory('333', date, '2026-04-02T23:00'), error => error.getStatus() === 400);
  assert.throws(() => api.truckHistory('333', '2026-04-02T23:00', '2026-04-01T06:00'), error => error.getStatus() === 400);
  assert.doesNotThrow(() => api.truckHistory('333', '2024-02-29T06:00', '2024-02-29T06:00'));
});

test('truck history binds procedure parameters and preserves both ordered result sets', async () => {
  const db = new DbService();
  const start = new Date('2026-04-01T06:00:00Z');
  const end = new Date('2026-04-02T23:00:00Z');
  const sets = [[{ Transaksi: 'Kirim', CTFinalTonnageID: 1 }, { Transaksi: 'Terima', dtDeletedAt: 'deleted' }], [{ trans: 'Kirim - Kosong', flTonnage: 0 }]];
  const request = new sql.Request();
  let resultSets = sets;
  request.execute = async name => {
    assert.equal(name, 'dbo.spTruckTransactionHistory');
    assert.equal(request.parameters.EquipmentID.type, sql.Int);
    assert.equal(request.parameters.EquipmentID.value, 333);
    for (const [name, value] of [['starttime', start], ['endtime', end]]) {
      assert.equal(request.parameters[name].type, sql.DateTime);
      assert.equal(request.parameters[name].value, value);
    }
    assert.equal(request.overrides.requestTimeout, 60000);
    return { recordsets: resultSets };
  };
  db.connect = async () => ({ connected: true, request: () => request });
  const result = await db.truckHistory(333, start, end);
  assert.equal(result.equipmentId, 333);
  assert.equal(result.starttime, start);
  assert.equal(result.endtime, end);
  assert.deepEqual(result.transactions, sets[0]);
  assert.deepEqual(result.activities, sets[1]);
  assert.match(result.queries[0], /^EXEC dbo\.spTruckTransactionHistory @EquipmentID = 333, @starttime = '2026-04-01 06:00:00.000', @endtime = '2026-04-02 23:00:00.000'$/);
  // mssql prohibits binding same parameter twice on one request.
  request.parameters = {};
  resultSets = [];
  const empty = await db.truckHistory(333, start, end);
  assert.deepEqual(empty.transactions, []);
  assert.deepEqual(empty.activities, []);
  db.connect = async () => { throw Error('private connection details'); };
  db.logger = { error() {} };
  await assert.rejects(db.truckHistory(333, start, end), error => error.getStatus() === 503 && !error.message.includes('private'));
});
