const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planUserIds } = require('../dist/biostar');

test('suffix allocator retains free ids, allocates minimal candidates, and reserves conflicts', () => {
  // 3 bebas -> 3
  assert.deepEqual([...planUserIds(['3'], new Set()).entries()], [['3', '3']]);
  // 3 ada -> 30001 (4 digit padding, tanpa strip)
  assert.deepEqual([...planUserIds(['3'], new Set(['3'])).entries()], [['3', '30001']]);
  // 3 dan 30001 ada -> 30002
  assert.deepEqual([...planUserIds(['3'], new Set(['3', '30001'])).entries()], [['3', '30002']]);
  // 100 dan 2001 digunakan -> 1000001 (tidak memotong, tidak 00)
  assert.deepEqual([...planUserIds(['100'], new Set(['100', '2001'])).entries()], [['100', '1000001']]);
  // Melewati 99 -> 990001 (min 4 digit, tidak 0000)
  assert.deepEqual([...planUserIds(['99'], new Set(['99'])).entries()], [['99', '990001']]);
  // Sumber sudah ada angka -> teks utuh 300010001
  assert.deepEqual([...planUserIds(['30001'], new Set(['30001'])).entries()], [['30001', '300010001']]);
  // Nol di depan tetap (ketika bebas)
  assert.deepEqual([...planUserIds(['007'], new Set()).entries()], [['007', '007']]);
  // ID sumber yang sudah diambil disuffixkan; ID bebas tetap (free diproses dulu, lalu suffix)
  assert.deepEqual([...planUserIds(['3', '30001'], new Set(['3'])).entries()], [['30001', '30001'], ['3', '30002']]);
  // Deterministik sesuai urutan source_usr_uid; duplikasi dalam paket dihandle
  const result = planUserIds(['a', 'b', 'a'], new Set());
  assert.equal(result.size, 2);
  assert.equal(result.get('a'), 'a');
  assert.equal(result.get('b'), 'b');
});
