const { test } = require('node:test');
const assert = require('node:assert/strict');
const sql = require('mssql');
const { PcRegistryService, registryInput } = require('../dist/registry');
const { spawnSync } = require('node:child_process');
const pc = { id: "legacy-'ID", apiName: 'Target', ipAPI: '192.0.2.1', locationIDs: [8, 0, 7] };
const second = { ...pc, id: 'empty', apiName: 'Other', ipAPI: '192.0.2.2', locationIDs: [] };

test('import and identity validation fail before connecting; missing file fails closed', () => {
  let connects = 0;
  const registry = new PcRegistryService({ connect: async () => { connects++; throw Error('unexpected'); } });
  for (const value of [null, {}, [pc, pc], [pc, { ...pc, id: '' }], [pc, { ...pc, id: 'x', ipAPI: 'host' }], [{ ...pc, locationIDs: [1, 1] }], [{ ...pc, id: 'x'.repeat(201) }], [{ ...pc, locationIDs: [-1] }], [pc, { ...pc, id: 'duplicate-name' }]]) assert.throws(() => registry.import(value));
  for (const id of ['uuid', '0', '-1', '01', '1.5', '2147483648', '', null]) {
    assert.throws(() => registryInput([{ ...pc, id }]));
    if (id !== null) assert.throws(() => registry.remove(id));
  }
  assert.equal(connects, 0);
  assert.deepEqual(registryInput([{ ...pc, id: 2147483647 }]), [{ ...pc, id: '2147483647' }]);
  assert.deepEqual(registryInput(JSON.parse(('\uFEFF' + JSON.stringify([pc])).replace(/^\uFEFF/, '')), true), [pc]);
  const child = spawnSync(process.execPath, ['sql/import-api-registry.cjs', 'missing-registry-test-input.json'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ENOENT/);
});

test('identity SQL binding, string contract, atomic CRUD and import repeat/conflict safety', async () => {
  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  let rows = [], snapshot, commits = 0, rollbacks = 0, failure, nextId = 1;
  const pool = new sql.ConnectionPool({ server: '127.0.0.1' });
  const registry = new PcRegistryService({ connect: async () => { if (failure === 'connect') throw Error('sensitive'); return pool; } });
  sql.Transaction.prototype.begin = async function (level) { assert.equal(level, sql.ISOLATION_LEVEL.SERIALIZABLE); if (failure === 'begin') throw Error('sensitive'); snapshot = structuredClone(rows); };
  sql.Transaction.prototype.commit = async () => { if (failure === 'commit') throw Error('sensitive'); commits++; };
  sql.Transaction.prototype.rollback = async () => { rows = snapshot; rollbacks++; };
  sql.Request.prototype.query = async function (statement) {
    const p = Object.fromEntries(Object.entries(this.parameters).map(([key, p]) => [key, p.value]));
    if (failure === 'query') throw Error('sensitive');
    assert.ok(!statement.includes('ApiTargetLocations'));
    if (statement.startsWith('SELECT')) {
      assert.match(statement, /ORDER BY ApiName, Id/);
      return { recordset: [...rows].sort((a, b) => a.apiName.localeCompare(b.apiName) || a.id - b.id) };
    }
    if (this.parameters.id) {
      assert.equal(this.parameters.id.type, sql.Int);
      assert.equal(typeof p.id, 'number');
    }
    assert.ok(!statement.includes(pc.id));
    if (failure === 'location') throw Error('sensitive location failure');
    let id = p.id;
    if (statement.startsWith('INSERT dbo.ApiTargets')) {
      assert.equal(this.parameters.id, undefined);
      assert.match(statement, /OUTPUT inserted.Id AS id/);
      id = nextId++;
      rows.push({ id, apiName: p.name, ipAPI: p.ip, locationIDs: p.locations });
    } else if (statement.startsWith('UPDATE')) {
      assert.match(statement, /OUTPUT inserted.Id AS id/);
      Object.assign(rows.find(row => row.id === id), { apiName: p.name, ipAPI: p.ip, locationIDs: p.locations });
    } else if (statement.startsWith('DELETE dbo.ApiTargets')) rows = rows.filter(row => row.id !== id);
    else assert.fail(statement);
    return { recordset: [{ id }] };
  };
  try {
    assert.deepEqual(await registry.import([pc, second]), { inserted: 2, skipped: 0 });
    assert.deepEqual(await registry.list(), [{ ...second, id: '2' }, { ...pc, id: '1' }]);
    assert.deepEqual(await registry.import([pc, second]), { inserted: 0, skipped: 2 });
    for (const changed of [{ ...pc, apiName: 'different' }, { ...pc, locationIDs: [7, 0, 8] }]) await assert.rejects(registry.import([changed]), error => error.getStatus() === 409);
    assert.deepEqual(await registry.import([second, pc]), { inserted: 0, skipped: 2 });
    const original = structuredClone(rows);
    for (const locationIDs of ['broken', '{}', 'null', '[1,1]', '[true]', '[1.5]', '[-1]', '[2147483648]', JSON.stringify(Array(1001).fill(1))]) {
      rows[0].locationIDs = locationIDs;
      await assert.rejects(registry.list(), error => error.getStatus() === 503);
    }
    rows = structuredClone(original);
    await assert.rejects(registry.import([{ ...pc, id: 'new-before-conflict', apiName: 'New', ipAPI: '192.0.2.3' }, { ...pc, apiName: 'conflict' }]), error => error.getStatus() === 409);
    assert.deepEqual(rows, original);
    const before = structuredClone(rows);
    for (failure of ['location', 'commit', 'query', 'begin', 'connect']) {
      await assert.rejects(registry.save({ ...pc, apiName: 'edited' }, '1'), error => error.getStatus() === 503 && !error.message.includes('sensitive'));
      assert.deepEqual(rows, before);
    }
    failure = undefined;
    for (const action of [() => registry.save(pc, '999'), () => registry.remove('999')]) {
      const prior = rollbacks;
      await assert.rejects(action(), error => error.getStatus() === 404);
      assert.equal(rollbacks, prior + 1);
    }
    await registry.save({ ...pc, locationIDs: [7, 8] }, '1');
    assert.deepEqual((await registry.get('1')).locationIDs, [7, 8]);
    const created = await registry.save({ ...pc, locationIDs: [] });
    assert.equal(String(rows.at(-1).id), created.id);
    assert.equal(rows.at(-1).locationIDs, '[]');
    await registry.remove(created.id);
    assert.equal(rows.length, 2);
    failure = 'location';
    const prior = structuredClone(rows);
    await assert.rejects(registry.import([{ ...pc, id: 'new', apiName: 'New', ipAPI: '192.0.2.3' }]), error => error.getStatus() === 503);
    assert.deepEqual(rows, prior);
    failure = 'query';
    await assert.rejects(registry.list(), error => error.getStatus() === 503);
    assert.ok(commits > 0 && rollbacks > 0);
  } finally {
    for (const name of ['begin', 'commit', 'rollback']) sql.Transaction.prototype[name] = originals[name];
    sql.Request.prototype.query = originals.query;
  }
});
