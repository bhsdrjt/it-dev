const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const sql = require('mssql');
const { DbService } = require('../dist/db');
const { ApiController } = require('../dist/api');

test('coal calory endpoint validation', () => {
  const api = new ApiController(null, null, {
    coalCalories: () => 'rows',
    updateCoalCalory: (...args) => args,
    deleteTransaction: (...args) => args,
  });
  assert.equal(api.coalCalories(), 'rows');
  assert.deepEqual(api.updateCoalCalory('7', { coalQualityName: ' SEAM TC-SMU ', coalcalory: 6300 }), [7, 'SEAM TC-SMU', 6300]);
  assert.deepEqual(api.updateCoalCalory('7', { coalQualityName: 'SEAM', coalcalory: null }), [7, 'SEAM', null]);
  const bad = [
    { coalQualityName: 'SEAM' },
    { coalQualityName: '', coalcalory: 1 },
    { coalQualityName: 'X'.repeat(256), coalcalory: 1 },
    { coalQualityName: 'SEAM', coalcalory: -1 },
    { coalQualityName: 'SEAM', coalcalory: 1.5 },
    { coalQualityName: 'SEAM', coalcalory: '6300' },
    { coalQualityName: 'SEAM', coalcalory: 2147483648 },
  ];
  for (const body of bad) assert.throws(() => api.updateCoalCalory('7', body), e => e.getStatus() === 400, JSON.stringify(body));
  for (const id of ['0', 'x', '7.5', '-1', '']) assert.throws(() => api.updateCoalCalory(id, { coalQualityName: 'SEAM', coalcalory: 1 }), e => e.getStatus() === 400, id);
  // Hapus wajib konfirmasi dan ID positif.
  assert.deepEqual(api.deleteCoalCalory('7', { confirmed: true }), ['CoalCalory', 7]);
  for (const [id, body] of [['0', { confirmed: true }], ['x', { confirmed: true }], ['7', {}], ['7', { confirmed: false }], ['7', null]])
    assert.throws(() => api.deleteCoalCalory(id, body), e => e.getStatus() === 400, `${id} ${JSON.stringify(body)}`);
});

test('coal calory list only reads active rows', async () => {
  const db = new DbService();
  db.query = async statement => statement;
  const statement = await db.coalCalories();
  assert.match(statement, /FROM dbo\.tabCoalQualityAGM WHERE dtDeletedAt IS NULL/);
  assert.match(statement, /SELECT CoalQualityAGMID, CoalQualityID, CoalQualityName, Coalcalory, dtUpdatedAt/);
});

test('coal calory update locks the row, verifies one write, rolls back failures', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {}, log() {} };
  let scenario, commits, rollbacks, step;
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => { if (scenario === 'commit-error') throw Error('private'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    step++;
    assert.equal(this.parameters.id.value, 7);
    assert.equal(this.parameters.CoalQualityName.value, 'SEAM');
    assert.equal(this.parameters.Coalcalory.value, scenario === 'null-calory' ? null : 6300);
    if (step === 1) {
      assert.match(statement, /FROM dbo\.tabCoalQualityAGM WITH \(UPDLOCK, HOLDLOCK\)/);
      return { recordset: scenario === 'missing' ? [] : [{ dtDeletedAt: scenario === 'deleted' ? new Date() : null }] };
    }
    assert.match(statement, /SET CoalQualityName = @CoalQualityName, Coalcalory = @Coalcalory, dtUpdatedAt = GETDATE\(\)/);
    assert.match(statement, /OUTPUT inserted\.CoalQualityAGMID INTO @changed/);
    assert.match(statement, /WHERE CoalQualityAGMID = @id AND dtDeletedAt IS NULL/);
    if (scenario === 'sql-error') throw Error('private');
    return { recordset: [{ changed: scenario === 'no-write' ? 0 : 1 }] };
  };
  try {
    for (scenario of ['success', 'null-calory', 'missing', 'deleted', 'no-write', 'sql-error', 'commit-error']) {
      commits = rollbacks = step = 0;
      const calory = scenario === 'null-calory' ? null : 6300;
      const call = () => db.updateCoalCalory(7, 'SEAM', calory);
      if (scenario === 'success' || scenario === 'null-calory') assert.match((await call()).message, /diperbarui/);
      else await assert.rejects(call(), e => e.getStatus() === (scenario === 'missing' ? 404 : ['sql-error', 'commit-error'].includes(scenario) ? 503 : 409));
      assert.equal(commits, ['success', 'null-calory'].includes(scenario) ? 1 : 0);
      assert.equal(rollbacks, ['success', 'null-calory'].includes(scenario) ? 0 : 1);
    }
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    sql.Request.prototype.query = original.query;
  }
});

test('coal calory delete maps to tabCoalQualityAGM and only stamps dtDeletedAt', async () => {
  const original = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const db = new DbService();
  db.connect = async () => new sql.ConnectionPool({ server: '127.0.0.1', database: 'fixture' });
  db.logger = { error() {}, log() {} };
  let step = 0;
  sql.Transaction.prototype.begin = async () => {};
  sql.Transaction.prototype.commit = async () => {};
  sql.Transaction.prototype.rollback = async () => {};
  sql.Request.prototype.query = async function (statement) {
    step++;
    assert.equal(this.parameters.id.value, 7);
    assert.match(statement, /dbo\.tabCoalQualityAGM/);
    if (step === 2) {
      // Hapus hanya menyetel dtDeletedAt; kolom lain tidak ikut diubah.
      assert.match(statement, /SET dtDeletedAt = GETDATE\(\)/);
      assert.doesNotMatch(statement, /Coalcalory\s*=/);
      assert.doesNotMatch(statement, /CoalQualityName\s*=/);
      assert.doesNotMatch(statement, /dtUpdatedAt\s*=/);
    }
    if (step === 1) return { recordset: [{ dtDeletedAt: null }] };
    if (step === 2) return { recordset: [{ changed: 1 }] };
    return { recordset: [{ dtDeletedAt: new Date() }] };
  };
  try {
    const result = await db.deleteTransaction('CoalCalory', 7);
    assert.match(result.message, /ditandai dihapus/);
    assert.equal(step, 3);
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = original[name];
    sql.Request.prototype.query = original.query;
  }
});
