const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { BiostarService } = require('../dist/biostar');

function packageZip(indexValues = null) {
  const files = new Map(Object.entries({
    'users.csv': indexValues
      ? `source_usr_uid,USRID,NM,USRIDORD,IDXUSRID,IDXUSRIDNUM\n1006,4,Fixture,ignored,${indexValues.join(',')}\n`
      : 'source_usr_uid,USRID,NM\n1006,4,Fixture\n',
    'fingerprints.csv': 'source_usr_uid,FNGPIDX,DUR,TMPL0,TMPL1,CHS,LSTMOD\n',
    'cards.csv': 'source_crd_uid,CRDTYPUID,CRDCSN,ASMUID,WGDFMUID,WGDFMTVER\n',
    'user_cards.csv': 'source_usr_uid,source_crd_uid,IDX,ISSDDT,EXPDT,ISSDCNT,CRDMSK,PRDSTDT,PRDEDDT\n',
  }).map(([name, text]) => [name, Buffer.from(text)]));
  files.set('manifest.json', Buffer.from(JSON.stringify({
    format_version: 1, schema_contract_id: 'fixture', package_id: 'fixture', exported_at_utc: '2026-11-03T00:00:00Z', exporter_version: 'test', totals: {},
    files: [...files].map(([name, data]) => ({ name, size: data.length, records: name === 'users.csv' ? 1 : 0, sha256: createHash('sha256').update(data).digest('hex') })),
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

test('failed target query rejects preview instead of treating target as empty', async () => {
  const service = new BiostarService();
  service.biostarConnect = async () => ({ request: () => ({ query: async () => { throw Error('Fixture DB read failed'); } }) });
  const job = service.createJob('fixture', 'fixture-target');
  await assert.rejects(service.parsePackage(job.id, packageZip()), /Fixture DB read failed/);
  assert.equal(job.status, 'REJECTED');
  assert.equal(job.preview, null);
});
