const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { BiostarService } = require('../dist/biostar');

function packageZip(indexValues = null, overrides = {}) {
  const files = new Map(Object.entries({
    'users.csv': indexValues
      ? `source_usr_uid,USRID,NM,USRIDORD,IDXUSRID,IDXUSRIDNUM\n1006,4,Fixture,ignored,${indexValues.join(',')}\n`
      : 'source_usr_uid,USRID,NM\n1006,4,Fixture\n',
    'fingerprints.csv': 'source_usr_uid,FNGPIDX,DUR,TMPL0,TMPL1,CHS,LSTMOD\n',
    'cards.csv': 'source_crd_uid,CRDTYPUID,CRDCSN,ASMUID,WGDFMUID,WGDFMTVER\n',
    'user_cards.csv': 'source_usr_uid,source_crd_uid,IDX,ISSDDT,EXPDT,ISSDCNT,CRDMSK,PRDSTDT,PRDEDDT\n',
    ...overrides,
  }).map(([name, text]) => [name, Buffer.from(text)]));
  files.set('manifest.json', Buffer.from(JSON.stringify({
    format_version: 1, schema_contract_id: 'fixture', package_id: 'fixture', exported_at_utc: '2026-11-03T00:00:00Z', exporter_version: 'test', totals: {},
    files: [...files].map(([name, data]) => ({ name, size: data.length, records: data.toString().trimEnd().split('\n').length - 1, sha256: createHash('sha256').update(data).digest('hex') })),
  })));
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

for (const [existing, expected] of [[[], '4'], [['4'], '40001'], [['4', '40001'], '40002']]) {
  test(`preview uses target IDs ${existing.join(',')} and plans ${expected}`, async () => {
    const service = new BiostarService();
    const queries = [];
    service.biostarConnect = async () => ({ request: () => ({ query: async sql => {
      queries.push(sql);
      assert.match(sql, /^SELECT /);
      return { recordset: sql.includes('dbo.T_USR') ? existing.map(USRID => ({ USRID })) : [] };
    } }) });
    const job = service.createJob('fixture', 'fixture-target');
    await service.parsePackage(job.id, packageZip());
    assert.equal(job.status, 'READY');
    assert.ok(queries.some(sql => sql.includes('dbo.T_USR')));
    assert.equal(job.preview.users[0].targetUsrId, expected);
    assert.equal(job.parsed.users[0].targetUsrId, expected);
    assert.equal(job.preview.changedCount, expected === '4' ? 0 : 1);
  });
}

test('index columns preserve bigint values, blank or missing becomes null; USRIDORD stays ignored', async () => {
  const parse = async values => {
    const service = new BiostarService();
    service.biostarConnect = async () => ({ request: () => ({ query: async () => ({ recordset: [] }) }) });
    const job = service.createJob('fixture', 'fixture-target');
    await service.parsePackage(job.id, packageZip(values));
    assert.equal(job.status, 'READY');
    return job.parsed.users[0];
  };
  const missing = await parse(null);
  assert.equal(missing.idxUsrId, null);
  assert.equal(missing.idxUsrIdNum, null);
  assert.deepEqual(await parse(['', ' ']), missing);
  assert.deepEqual(await parse(['\\N', '\\N']), missing);
  const filled = await parse(['333000', '3000']);
  assert.equal(filled.idxUsrId, '333000');
  assert.equal(filled.idxUsrIdNum, '3000');
  const limits = await parse(['9223372036854775807', '-9223372036854775808']);
  assert.equal(limits.idxUsrId, '9223372036854775807');
  assert.equal(limits.idxUsrIdNum, '-9223372036854775808');
  const zero = await parse(['0', '0']);
  assert.equal(zero.idxUsrId, '0');
  assert.equal(zero.idxUsrIdNum, '0');
  for (const invalid of ['abc', '1.5', '9223372036854775808']) await assert.rejects(parse([invalid, '0']), /IDXUSRID/);
  assert.equal('usrIdOrd' in filled, false);
  const insert = BiostarService.prototype.startImport.toString();
  assert.doesNotMatch(insert, /USRIDORD/);
  assert.match(insert, /cols.push\('IDXUSRID', 'IDXUSRIDNUM'\)/);
  assert.match(insert, /vals.push\(u.idxUsrId \?\? null, u.idxUsrIdNum \?\? null\)/);
});

test('exact destination names skip users and dependent credentials, including transactional recheck', async () => {
  const sql = require('mssql');
  const zip = packageZip(null, {
    'users.csv': 'source_usr_uid,USRID,NM\n1,4,Fixture\n2,5,fixture\n3,6,Fixture \n4,7,New\n',
    'fingerprints.csv': 'source_usr_uid,FNGPIDX,DUR,TMPL0,TMPL1,CHS,LSTMOD\n1,0,N,,,,\n2,0,N,,,,\n',
    'cards.csv': 'source_crd_uid,CRDTYPUID,CRDCSN,ASMUID,WGDFMUID,WGDFMTVER\n10,0,SKIPPED,,,\n11,0,SHARED,,,\n12,0,NEW,,,\n',
    'user_cards.csv': 'source_usr_uid,source_crd_uid,IDX,ISSDDT,EXPDT,ISSDCNT,CRDMSK,PRDSTDT,PRDEDDT\n1,10,0,,,,,,\n1,11,1,,,,,,\n2,11,0,,,,,,\n4,12,0,,,,,,\n',
  });
  const service = new BiostarService();
  service.biostarConnect = async () => ({ request: () => ({ query: async text => ({
    recordset: text.includes('dbo.T_USR') ? [{ USRID: null, NM: 'Fixture' }] : [],
  }) }) });
  const job = service.createJob('fixture', 'fixture-target');
  await service.parsePackage(job.id, zip);
  assert.deepEqual(job.preview.users.map(u => u.status), ['Dilewati', 'Tetap', 'Tetap', 'Tetap']);
  assert.equal(job.preview.users[0].targetUsrId, '');
  assert.match(job.preview.users[0].reason, /Nama sama persis/);
  assert.equal(job.preview.unchangedCount, 3);
  assert.deepEqual(job.parsed.users.map(u => u.nm), ['fixture', 'Fixture ', 'New']);
  assert.deepEqual(job.parsed.fingerprints.map(f => f.sourceUsrUid), ['2']);
  assert.deepEqual(job.parsed.cards.map(c => c.sourceCrdUid), ['11', '12']);
  assert.deepEqual(job.parsed.relations.map(r => r.sourceUsrUid), ['2', '4']);
  assert.deepEqual(job.preview.credentialCount, { fingerprint: 1, card: 2, relation: 2 });
  assert.equal(job.summary.userCount, 4, 'source package summary unchanged');
  await service.confirm(job.id, 1);

  const originals = { begin: sql.Transaction.prototype.begin, commit: sql.Transaction.prototype.commit, rollback: sql.Transaction.prototype.rollback, query: sql.Request.prototype.query };
  const inserts = [];
  let committed = false, rolledBack = false, lockedRead = false;
  sql.Transaction.prototype.begin = async function () {};
  sql.Transaction.prototype.commit = async function () { committed = true; };
  sql.Transaction.prototype.rollback = async function () { rolledBack = true; };
  sql.Request.prototype.query = async function (text) {
    if (text.startsWith('SELECT USRID')) {
      assert.ok(this.parent instanceof sql.Transaction);
      assert.match(text, /WITH \(UPDLOCK, HOLDLOCK\)/);
      lockedRead = true;
      return { recordset: [{ NM: 'Fixture' }, { NM: 'New' }] };
    }
    if (text.startsWith('SELECT CRDCSN')) return { recordset: [{ CRDCSN: 'SKIPPED' }, { CRDCSN: 'NEW' }] };
    if (text.startsWith('INSERT')) inserts.push({ text, values: Object.values(this.parameters).map(p => p.value) });
    return { recordset: [{ newId: inserts.length }] };
  };
  try {
    await service.startImport(job.id);
    assert.ok(lockedRead && committed && !rolledBack);
    assert.equal(job.status, 'COMMITTED');
    assert.deepEqual(job.preview.users.map(u => u.status), ['Dilewati', 'Tetap', 'Tetap', 'Dilewati']);
    assert.equal(inserts.filter(i => i.text.startsWith('INSERT INTO dbo.T_USR (')).length, 2);
    assert.equal(inserts.filter(i => i.text.startsWith('INSERT INTO dbo.T_FNGPTMPL')).length, 1);
    assert.equal(inserts.filter(i => i.text.startsWith('INSERT INTO dbo.T_CRD')).length, 1);
    assert.equal(inserts.filter(i => i.text.startsWith('INSERT INTO dbo.T_USRCRD')).length, 1);
    assert.ok(!inserts.some(i => i.values.some(v => ['Fixture', 'New', 'SKIPPED', 'NEW'].includes(v))));

    const all = service.createJob('all', 'fixture-target');
    await service.parsePackage(all.id, packageZip());
    assert.equal(all.parsed.users.length, 0);
    await assert.rejects(service.confirm(all.id, 1), /Tidak ada user baru/);
    all.status = 'QUEUED';
    inserts.length = 0;
    committed = false;
    await assert.rejects(service.startImport(all.id), /Tidak ada user baru/);
    assert.ok(rolledBack && !committed);
    assert.equal(inserts.length, 0);
  } finally {
    Object.assign(sql.Transaction.prototype, { begin: originals.begin, commit: originals.commit, rollback: originals.rollback });
    sql.Request.prototype.query = originals.query;
  }
});

test('failed target query rejects preview instead of treating target as empty', async () => {
  const service = new BiostarService();
  service.biostarConnect = async () => ({ request: () => ({ query: async () => { throw Error('Fixture DB read failed'); } }) });
  const job = service.createJob('fixture', 'fixture-target');
  await assert.rejects(service.parsePackage(job.id, packageZip()), /Fixture DB read failed/);
  assert.equal(job.status, 'REJECTED');
  assert.equal(job.preview, null);
});
