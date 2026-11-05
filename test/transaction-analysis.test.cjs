const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const compiled = { exports: {} };
new Function('module', 'exports', transformSync(readFileSync(join(__dirname, '../web/transaction-analysis.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(compiled, compiled.exports);
const { analyzeTransactions, activityStage, groupTruckActivities, groupTruckTransactions } = compiled.exports;
test('transaction trips use stored references, preserve orphan and ambiguous rows', () => {
  const send = (id, ref) => ({ Transaksi: 'Loading', CTFinalTonnageID: id, RefDumpingTonnageID: ref, CoalDeliveryNumber: 'SAME', dtEmpty: '2026-04-01T07:00:00' });
  const receive = id => ({ Transaksi: 'Dumping', CTFinalTonnageID: id, CoalDeliveryNumber: 'SAME', dtEmpty: '2026-04-01T09:00:00' });
  const a = send(1, 10), b = send(2, 20), x = receive(10), y = receive(20), orphan = receive(30);
  const groups = groupTruckTransactions([orphan, y, b, x, a]);
  assert.deepEqual(groups.map(group => group.rows), [[b, y], [a, x], [orphan]]);
  assert.equal(groups[0].status, 'Terhubung');
  assert.equal(groups[2].status, 'Belum lengkap');
  for (const rows of [[send(1, null), x], [send(1, 10), send(2, 10), x], [a, x, receive(10)], [a]]) {
    const result = groupTruckTransactions(Object.freeze(rows));
    const flattened = result.flatMap(group => group.rows);
    assert.equal(flattened.length, rows.length);
    rows.forEach(row => assert.equal(flattened.filter(item => item === row).length, 1));
    assert.ok(result.every(group => group.rows.length === 1));
  }
  assert.deepEqual(groupTruckTransactions([]), []);
});
test('truck groups preserve rows, sort time, close trips and flag incomplete or unusual sequences', () => {
  const row = (trans, minute, sk = null) => Object.freeze({ trans, dtTimeCollected: `2026-04-01T06:${String(minute).padStart(2, '0')}:00.000Z`, CoalDeliveryNumber: sk });
  const complete = [row('Kirim kosong', 0), row('Kirim muat', 1, 'SK1'), row('Tollgate', 2), row('Tollgate', 3), row('Terima muat', 4), row('Terima kosong', 5)];
  const groups = groupTruckActivities(Object.freeze([...complete].reverse()));
  assert.equal(groups[0].status, 'Lengkap');
  assert.deepEqual(groups[0].rows, complete);
  assert.deepEqual(groups[0].sk, ['SK1']);
  assert.equal(groups[0].end - groups[0].start, 300000);
  const partial = groupTruckActivities([row('Tollgate', 0), row('Kirim kosong', 1), row('Kirim kosong', 2), row('Terima kosong', 3)]);
  assert.equal(partial.length, 3);
  assert.ok(partial[0].notes.includes('Awal ritase tidak terlihat'));
  assert.ok(partial[1].notes.includes('Akhir ritase tidak terlihat'));
  assert.equal(partial[2].status, 'Belum lengkap');
  const odd = [row('Kirim kosong', 0), row('Terima muat', 1), row('Kirim muat', 2, 'A'), row('Kirim muat', 3, 'B'), row('Other', 4), row('Terima kosong', 5), { trans: 'MT', dtTimeCollected: null }];
  const unusual = groupTruckActivities(odd);
  assert.equal(unusual[0].status, 'Urutan perlu diperiksa');
  assert.equal(unusual[1].status, 'Urutan perlu diperiksa');
  assert.deepEqual(unusual.flatMap(group => group.rows), odd);
  assert.equal(groupTruckActivities([]).length, 0);
});
const at = time => `2026-07-13T${time}:00.000Z`;
const loading = { Transaksi: 'Loading', CTFinalTonnageID: 10, RefDumpingTonnageID: 20, CoalDeliveryNumber: 'TARGET', EquipmentID: 1, strEquipmentName: 'TR1', dtEmpty: at('10:00'), dtLoaded: at('11:00') };
const dumping = { Transaksi: 'Dumping', CTFinalTonnageID: 20, CoalDeliveryNumber: 'TARGET', EquipmentID: 1, dtLoaded: at('12:00'), dtEmpty: at('12:30') };
const next = { ...loading, CTFinalTonnageID: 11, RefDumpingTonnageID: 21, CoalDeliveryNumber: 'NEXT', dtEmpty: at('13:00'), dtLoaded: at('14:00') };
const event = (trans, time, extra = {}) => ({ trans, strTruckCN: 'TR1', dtTimeCollected: at(time), CoalDeliveryNumber: null, ...extra });
const events = [event('Kirim - Kosong', '10:00'), event('Net Reader', '10:30', { ReaderLocationName: 'MT01' }), event('Kirim - Muat', '11:00', { CoalDeliveryNumber: 'TARGET' }), event('Tol Gate', '11:20'), event('Tol Gate', '11:40'), event('Terima - Muat', '12:00'), event('Terima - Kosong', '12:30')];
const codes = findings => findings.map(item => item.code);
test('New Assignment stays visible without changing stages, trip boundaries or pairing', () => {
  const assignment = Object.freeze(event('New Assignment', '11:30', { LoadingLocationName: 'PIT A', DumpingLocationName: 'PORT B', ReaderLocationName: null }));
  const baseline = analyzeTransactions([loading, dumping], events, 'TARGET');
  const result = analyzeTransactions([loading, dumping], Object.freeze([...events, assignment]), 'TARGET');
  assert.deepEqual(result.pairs, baseline.pairs);
  assert.deepEqual(result.journeys[0].counts, baseline.journeys[0].counts);
  assert.equal(result.journeys[0].start, baseline.journeys[0].start);
  assert.equal(result.journeys[0].end, baseline.journeys[0].end);
  assert.ok(result.journeys[0].candidates.some(item => item.row === assignment && item.stage === null));
  assert.ok(!codes(result.journeys[0].findings).includes('unknown-events'));
  const group = groupTruckActivities([...events, assignment])[0];
  assert.equal(group.status, 'Lengkap');
  assert.equal(group.rows[4], assignment);
  const outside = [event('New Assignment', '09:00'), event('New Assignment', '12:40'), { trans: 'New Assignment', dtTimeCollected: null }];
  const groups = groupTruckActivities([...events, ...outside]);
  assert.equal(groups.length, 4);
  for (const index of [0, 2, 3]) {
    assert.equal(groups[index].status, 'Perubahan assignment');
    assert.ok(!groups[index].notes.some(note => /Tahap belum|Jenis aktivitas/.test(note)));
  }
  assert.match(groups[3].notes[0], /Waktu tidak valid/);
  assert.equal(groups.flatMap(group => group.rows).length, events.length + outside.length);
  assert.equal(compiled.exports.isNewAssignment({ trans: ' NEW_ASSIGNMENT ' }), true);
  assert.equal(compiled.exports.isNewAssignment({ trans: 'Other' }), false);
  assert.equal(groupTruckActivities([...events, event('Other', '11:30')])[0].status, 'Urutan perlu diperiksa');
});

test('Net Reader at CP locations is MT; repeated readings before loading are valid', () => {
  const readings = ['CP 10', 'CP 09', 'CP 10'].map((ReaderLocationName, i) => event(i === 1 ? 'NetReader' : 'Net Reader', `10:${20 + i}`, { ReaderLocationName }));
  for (const row of readings) assert.equal(activityStage(row), 1);
  const trip = groupTruckActivities([...events.filter(row => row.trans !== 'Net Reader'), ...readings])[0];
  assert.equal(trip.status, 'Lengkap');
  assert.equal(trip.rows.filter(row => activityStage(row) === 1).length, 3);
  assert.equal(groupTruckActivities([...trip.rows, event('Net Reader', '11:10', { ReaderLocationName: 'CP 10' })])[0].status, 'Urutan perlu diperiksa');
});

test('AF26R000012: trip without Kirim activities pairs by CDN and same-second physical times', () => {
  const kirim = { ...loading, CTFinalTonnageID: 2741276, RefDumpingTonnageID: null, CoalDeliveryNumber: 'AF26R000012', EquipmentID: 116, strEquipmentName: 'TR07017', dtEmpty: '2026-04-21T16:10:31.000Z', dtLoaded: '2026-04-21T16:27:31.000Z' };
  const terima = { ...dumping, CTFinalTonnageID: 3738119, CoalDeliveryNumber: kirim.CoalDeliveryNumber, EquipmentID: 116, dtLoaded: '2026-04-21T17:16:19.000Z', dtEmpty: '2026-04-21T17:21:40.000Z' };
  const rows = [
    ['Terima - Muat', '2026-04-21T17:16:19.350Z', null], ['Terima - Kosong', '2026-04-21T17:21:40.247Z', null],
    ['Kirim - Kosong', '2026-04-21T19:09:53.027Z', null], ['Kirim - Muat', '2026-04-21T20:26:14.667Z', 'NEXT'],
  ].map(([trans, dtTimeCollected, CoalDeliveryNumber]) => ({ trans, dtTimeCollected, CoalDeliveryNumber, strTruckCN: 'TR07017' }));
  const result = analyzeTransactions([kirim, terima], rows, kirim.CoalDeliveryNumber);
  assert.equal(result.pairs[0].unpairedDumping, terima);
  assert.ok(codes(result.pairs[0].findings).includes('not-auto-paired'));
  const journey = result.journeys[0];
  assert.ok(codes(journey.findings).includes('not-auto-paired'));
  assert.match(journey.findings.find(item => item.code === 'not-auto-paired').text, /detik yang sama/);
  assert.equal(journey.end, '2026-04-21T17:21:40.247Z');
  assert.deepEqual(journey.counts, [0, 0, 0, 0, 1, 1]);
  assert.ok(codes(journey.findings).includes('missing-0'));
  assert.ok(codes(journey.findings).includes('missing-2'));
  // Presisi bukan .000 tidak boleh cocok beda milidetik.
  for (const [dtLoaded, dtEmpty] of [['2026-04-21T17:16:19.351Z', '2026-04-21T17:21:40.000Z'], ['2026-04-21T17:16:19.000Z', '2026-04-21T17:21:40.248Z'], ['2026-04-21T17:16:20.000Z', '2026-04-21T17:21:41.000Z']]) {
    const missed = analyzeTransactions([kirim, { ...terima, dtLoaded, dtEmpty }], rows, kirim.CoalDeliveryNumber);
    assert.equal(missed.pairs[0].unpairedDumping, undefined);
    assert.ok(!codes(missed.pairs[0].findings).includes('not-auto-paired'));
  }
  // .000 yang sama detiknya tetap cocok; beda detik tidak.
  const sameSecond = analyzeTransactions([kirim, { ...terima, dtLoaded: '2026-04-21T17:16:19.000Z', dtEmpty: '2026-04-21T17:21:40.000Z' }], rows.map(row => row.trans === 'Terima - Muat' ? { ...row, dtTimeCollected: '2026-04-21T17:16:19.999Z' } : row), kirim.CoalDeliveryNumber);
  assert.equal(sameSecond.pairs[0].unpairedDumping.CTFinalTonnageID, 3738119);
});

test('dispatcher marker requires explicit zero milliseconds on final Kirim/Terima only', () => {
  const { isDispatcherCreated } = compiled.exports;
  for (const Transaksi of ['Kirim', 'Terima', 'Loading', 'Dumping']) {
    for (const dtTimeCollected of ['2026-03-13T23:01:12.000Z', '2026-03-13 23:01:12,000', '2026-03-13T23:01:12.000+08:00']) {
      assert.equal(isDispatcherCreated({ Transaksi, dtTimeCollected }), true);
    }
    for (const dtTimeCollected of [null, '', 'invalid.000', '2026-03-13T23:01:12Z', '2026-03-13T23:01:12.003Z', '2026-03-13T23:01:12.100Z']) {
      assert.equal(isDispatcherCreated({ Transaksi, dtTimeCollected }), false);
    }
  }
  for (const Transaksi of ['RawTerima', 'TerimaRaw', 'RawDumping', 'Kirim - Muat', '']) {
    assert.equal(isDispatcherCreated({ Transaksi, dtTimeCollected: at('11:00') }), false);
  }
});

test('AF260028521: matching physical receipt without reference gets note on both rows without pairing', () => {
  const current = { ...loading, CTFinalTonnageID: 2684932, RefDumpingTonnageID: null, CoalDeliveryNumber: 'AF260028521', dtEmpty: '2026-03-13T21:01:19.823Z', dtLoaded: '2026-03-13T23:01:12.373Z' };
  const receipt = { ...dumping, CTFinalTonnageID: 3675913, CoalDeliveryNumber: current.CoalDeliveryNumber, dtLoaded: '2026-03-16T20:00:23.027Z', dtEmpty: '2026-03-16T20:06:09.880Z' };
  const activities = [
    ['Kirim - Kosong', current.dtEmpty, null], ['Kirim - Muat', current.dtLoaded, current.CoalDeliveryNumber],
    ['Terima - Muat', receipt.dtLoaded, null], ['Terima - Kosong', receipt.dtEmpty, null],
  ].map(([trans, dtTimeCollected, CoalDeliveryNumber]) => ({ trans, dtTimeCollected, CoalDeliveryNumber, strTruckCN: 'TR1' }));
  const analyze = rows => analyzeTransactions(rows, activities, current.CoalDeliveryNumber);
  const result = analyze([current, receipt]);
  assert.equal(result.pairs[0].loading, current);
  assert.equal(result.pairs[0].unpairedDumping, receipt);
  assert.equal(result.pairs[0].dumping, undefined);
  assert.equal(current.RefDumpingTonnageID, null);
  assert.match(result.pairs[0].findings.find(item => item.code === 'not-auto-paired').text, /^data tidak berpasangan otomatis/);
  assert.ok(codes(result.journeys[0].findings).includes('not-auto-paired'));
  assert.ok(!codes(result.journeys[0].findings).includes('physical-pair-mismatch'));
  for (const rows of [
    [current], [current, { ...receipt, EquipmentID: 99 }], [current, { ...receipt, CoalDeliveryNumber: 'OTHER' }],
    [current, { ...receipt, dtDeletedAt: at('15:00') }], [current, { ...receipt, dtLoaded: at('12:00') }],
    [current, receipt, { ...receipt, CTFinalTonnageID: 99 }],
    [current, receipt, { ...loading, RefDumpingTonnageID: receipt.CTFinalTonnageID }],
    [{ ...current, RefDumpingTonnageID: receipt.CTFinalTonnageID }, receipt],
    [{ ...current, RefDumpingTonnageID: 999 }, receipt],
    [{ ...current, dtDeletedAt: at('15:00') }, receipt],
    [current, receipt, { ...current, CTFinalTonnageID: 99 }],
  ]) {
    assert.equal(analyze(rows).pairs[0].unpairedDumping, undefined);
    assert.ok(!codes(analyze(rows).pairs[0].findings).includes('not-auto-paired'));
  }
});

// Kontrak refactor: analisa boleh menambah temuan keluaran, bukan mengubah bukti asli.
test('analysis preserves frozen inputs and returns independent findings on repeated calls', () => {
  const transactions = Object.freeze([loading, dumping, next].map(row => Object.freeze({ ...row })));
  const activities = Object.freeze(events.map(row => Object.freeze({ ...row })));
  const snapshot = JSON.stringify({ transactions, activities });
  const first = analyzeTransactions(transactions, activities, 'TARGET');
  const second = analyzeTransactions(transactions, activities, 'TARGET');

  assert.equal(JSON.stringify({ transactions, activities }), snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.pairs[0].loading, transactions[0]);
  assert.equal(first.pairs[0].dumping, transactions[1]);
  assert.notEqual(first.pairs[0].findings, second.pairs[0].findings);
  assert.notEqual(first.journeys[0].findings, second.journeys[0].findings);
  first.pairs[0].findings.push({ code: 'test-only', level: 'info', text: 'Only this result changes.' });
  assert.ok(!codes(second.pairs[0].findings).includes('test-only'));
});

test('Kirim/Terima procedure labels retain reference pairing and journey analysis', () => {
  const result = analyzeTransactions([{ ...loading, Transaksi: 'Kirim' }, { ...dumping, Transaksi: 'Terima' }, { ...next, Transaksi: 'Kirim' }], events, 'TARGET');
  assert.equal(result.pairs[0].dumping.CTFinalTonnageID, 20);
  assert.deepEqual(result.journeys[0].counts, [1, 1, 1, 2, 1, 1]);
  for (const Transaksi of ['RawDumping', 'RawTerima', 'TerimaRaw']) {
    assert.equal(compiled.exports.transactionKind({ Transaksi }), 'TerimaRaw');
    assert.equal(analyzeTransactions([{ ...loading, Transaksi: 'Kirim' }, { ...dumping, Transaksi }], [], 'TARGET').pairs[0].dumping, undefined);
  }
});

test('reference join never substitutes same CDN or RawDumping; previous-trip mismatch and reused references detected', () => {
  const previous = { ...loading, CTFinalTonnageID: 9, CoalDeliveryNumber: 'PREVIOUS', dtEmpty: at('08:00'), dtLoaded: at('09:00') };
  const result = analyzeTransactions([previous, loading, { ...dumping, CoalDeliveryNumber: 'PREVIOUS', dtLoaded: at('09:20'), dtEmpty: at('09:40') }], [], 'TARGET');
  const pair = result.pairs[1];
  assert.equal(pair.dumping.CTFinalTonnageID, 20);
  assert.ok(codes(pair.findings).includes('cdn-mismatch'));
  assert.match(pair.findings.find(item => item.code === 'cdn-mismatch').text, /ritase sebelumnya/);
  assert.ok(codes(pair.findings).includes('shared-reference'));
  assert.ok(codes(pair.findings).includes('dumping-before-loading'));
  const absent = analyzeTransactions([loading, { ...dumping, CTFinalTonnageID: 99 }, { ...dumping, Transaksi: 'RawDumping' }], [], 'TARGET').pairs[0];
  assert.equal(absent.dumping, undefined);
  assert.ok(codes(absent.findings).includes('unresolved-reference'));
  assert.ok(codes(absent.findings).includes('cdn-only-candidate'));
  assert.equal(absent.findings.find(item => item.code === 'unresolved-reference').level, 'info');
  assert.ok(codes(analyzeTransactions([{ ...loading, RefDumpingTonnageID: null }], [], 'TARGET').pairs[0].findings).includes('no-reference'));
});

test('complete order accepts two Tollgates and ignores subsequent trip; shuffled input sorted by time', () => {
  const result = analyzeTransactions([loading, dumping, next], [...events, event('Kirim - Muat', '14:00', { CoalDeliveryNumber: 'NEXT' })].reverse(), 'TARGET');
  assert.deepEqual(result.journeys[0].counts, [1, 1, 1, 2, 1, 1]);
  assert.equal(result.journeys[0].findings.some(item => item.level === 'warn'), false);
  assert.ok(codes(result.journeys[0].findings).includes('sequence-observed'));
  assert.equal(result.pairs[0].findings.length, 0);
});

test('repeated Muat Kirim, reversed events, third Tollgate and missing stages are explicit', () => {
  const repeated = analyzeTransactions([loading, dumping, next], [...events, event('Kirim - Muat', '11:10', { CoalDeliveryNumber: 'TARGET' })], 'TARGET').journeys[0];
  assert.ok(codes(repeated.findings).includes('duplicate-2'));
  const bad = analyzeTransactions([loading, dumping, next], [...events.filter(row => row.trans !== 'Net Reader'), event('Tol Gate', '12:10'), event('Kirim - Muat', '12:15', { CoalDeliveryNumber: 'TARGET' })], 'TARGET').journeys[0];
  assert.ok(codes(bad.findings).includes('out-of-order'));
  assert.ok(codes(bad.findings).includes('duplicate-3'));
  assert.ok(!codes(bad.findings).includes('missing-1'));
  assert.equal(bad.findings.find(item => item.code === 'optional-mt').level, 'info');
});

test('MT is optional: direct empty to loaded remains valid without claiming manual origin selection', () => {
  const withoutMt = events.filter(row => row.trans !== 'Net Reader');
  const journey = analyzeTransactions([loading, dumping, next], withoutMt, 'TARGET').journeys[0];
  assert.deepEqual(journey.counts, [1, 0, 1, 2, 1, 1]);
  assert.ok(codes(journey.findings).includes('sequence-observed'));
  assert.ok(!codes(journey.findings).includes('missing-1'));
  assert.equal(journey.findings.some(item => item.level === 'warn'), false);
  assert.match(journey.findings.find(item => item.code === 'optional-mt').text, /tidak membuktikan pemilihan manual/);
  assert.equal(journey.candidates[0].basis, 'Urutan sebelum SK terbit');
  const open = analyzeTransactions([loading], withoutMt, 'TARGET').journeys[0];
  assert.deepEqual(open.counts, [1, 0, 1, 2, 1, 1]);
  assert.equal(open.end, at('12:30'));
  const wrongOrder = analyzeTransactions([loading, dumping, next], [...withoutMt, event('Net Reader', '11:10', { ReaderLocationName: 'MT01' })], 'TARGET').journeys[0];
  assert.ok(codes(wrongOrder.findings).includes('out-of-order'));
});

test('pre-CDN empty belongs to following loaded event, even without next trip or matching dtEmpty', () => {
  const result = analyzeTransactions([{ ...loading, dtEmpty: at('10:05') }], events, 'TARGET').journeys[0];
  assert.equal(result.start, at('10:00'));
  assert.deepEqual(result.counts, [1, 1, 1, 2, 1, 1]);
  assert.equal(result.candidates[0].row.CoalDeliveryNumber, null);
  for (const blocker of [event('Kirim - Muat', '10:45', { CoalDeliveryNumber: 'OTHER' }), event('Terima - Kosong', '10:45')]) {
    const blocked = analyzeTransactions([loading], [...events, blocker], 'TARGET').journeys[0];
    assert.equal(blocked.counts[0], 0);
    assert.ok(!codes(blocked.findings).includes('pre-cdn-sequence'));
  }
  const wrongTruck = events.map(row => row.trans === 'Kirim - Kosong' ? { ...row, strTruckCN: 'TR2' } : row);
  assert.equal(analyzeTransactions([loading], wrongTruck, 'TARGET').journeys[0].counts[0], 0);
  const duplicate = [...events, event('Kirim - Muat', '11:10', { CoalDeliveryNumber: 'TARGET' })];
  assert.ok(codes(analyzeTransactions([loading], duplicate, 'TARGET').journeys[0].findings).includes('duplicate-2'));
});

test('Terima Kosong closes CDN inclusively without next Loading and excludes later events', () => {
  const journey = analyzeTransactions([loading], [...events, event('Tol Gate', '12:40'), event('Kirim - Muat', '12:50', { CoalDeliveryNumber: 'TARGET' }), event('Terima - Kosong', '12:55')], 'TARGET').journeys[0];
  assert.equal(journey.end, at('12:30'));
  assert.deepEqual(journey.counts, [1, 1, 1, 2, 1, 1]);
  assert.equal(journey.candidates.at(-1).row.trans, 'Terima - Kosong');
  assert.equal(journey.candidates.at(-1).basis, 'Urutan ritase hingga Terima Kosong');
  assert.ok(!codes(journey.findings).includes('duplicate-2'));
  const unfinished = analyzeTransactions([loading, next], [...events.filter(row => row.trans !== 'Terima - Kosong'), event('Kirim - Kosong', '13:00'), event('Terima - Kosong', '13:30')], 'TARGET').journeys[0];
  assert.equal(unfinished.end, null);
  assert.deepEqual(unfinished.counts, [1, 1, 1, 2, 1, 0]);
  assert.ok(codes(unfinished.findings).includes('open-window'));
});

test('dispatch before closing and receipt without generated Dumping are anomalies with coverage caveats', () => {
  const unfinished = events.filter(row => row.trans !== 'Terima - Kosong');
  for (const additional of [event('Kirim - Kosong', '13:00'), event('Kirim - Muat', '13:00', { CoalDeliveryNumber: 'NEXT' }), event('Kirim - Muat', '11:10', { CoalDeliveryNumber: 'TARGET' })]) {
    const journey = analyzeTransactions([loading, dumping], [...unfinished, additional], 'TARGET').journeys[0];
    assert.equal(journey.findings.find(item => item.code === 'dispatch-before-receipt').level, 'warn');
  }
  const closed = analyzeTransactions([loading, dumping], [...events, event('Kirim - Kosong', '13:00')], 'TARGET').journeys[0];
  assert.ok(!codes(closed.findings).includes('dispatch-before-receipt'));
  assert.ok(!codes(closed.findings).includes('receipt-without-dumping'));
  const missingDumping = analyzeTransactions([loading], events, 'TARGET').journeys[0];
  const missing = missingDumping.findings.find(item => item.code === 'receipt-without-dumping');
  assert.equal(missing.level, 'warn');
  assert.match(missing.text, /belum membuktikan/);
  const unlinked = analyzeTransactions([{ ...loading, RefDumpingTonnageID: null }, dumping], events, 'TARGET').journeys[0];
  assert.ok(codes(unlinked.findings).includes('not-auto-paired'));
  assert.ok(!codes(unlinked.findings).includes('physical-pair-mismatch'));
  assert.ok(!codes(unlinked.findings).includes('receipt-without-dumping'));
  assert.ok(!codes(analyzeTransactions([loading], unfinished, 'TARGET').journeys[0].findings).includes('receipt-without-dumping'));
});

test('AD260000095: physical receipt identifies Dumping incorrectly linked to previous CDN', () => {
  const stamp = time => `2026-01-19T${time}Z`;
  const previous = { ...loading, CTFinalTonnageID: 2619892, RefDumpingTonnageID: 3585292, CoalDeliveryNumber: 'AD260005460', dtEmpty: stamp('08:22:05.727'), dtLoaded: stamp('09:16:31.357') };
  const current = { ...loading, CTFinalTonnageID: 2619931, RefDumpingTonnageID: null, CoalDeliveryNumber: 'AD260000095', dtEmpty: stamp('10:20:51.777'), dtLoaded: stamp('11:07:25.387') };
  const wrong = { ...dumping, CTFinalTonnageID: 3585292, CoalDeliveryNumber: 'AD260005460', dtLoaded: stamp('11:35:24.893'), dtEmpty: stamp('11:51:09.580') };
  const rows = [
    ['Kirim - Kosong', '08:22:05.727', null], ['Kirim - Muat', '09:16:31.357', 'AD260005460'], ['Terima - Muat', '09:43:48.513', null], ['Terima - Kosong', '09:59:09.113', null],
    ['Kirim - Kosong', '10:20:51.777', null], ['Kirim - Muat', '11:07:25.387', 'AD260000095'], ['Tol Gate', '11:26:12.030', null], ['Terima - Muat', '11:35:24.893', null], ['Terima - Kosong', '11:51:09.580', null],
  ].map(([trans, time, CoalDeliveryNumber]) => ({ trans, dtTimeCollected: stamp(time), CoalDeliveryNumber, strTruckCN: 'TR1' }));
  const result = analyzeTransactions([previous, current, wrong], rows, 'AD260000095');
  assert.ok(codes(result.pairs[0].findings).includes('linked-dumping-close-mismatch'));
  assert.ok(codes(result.pairs[0].findings).includes('dumping-belongs-other-trip'));
  assert.equal(result.pairs[1].dumping, undefined, 'stored relationship stays unchanged');
  assert.ok(codes(result.pairs[1].findings).includes('physical-pair-mismatch'));
  const evidence = result.journeys[0].findings.find(item => item.code === 'physical-pair-mismatch').text;
  assert.match(evidence, /3585292/); assert.match(evidence, /AD260005460/); assert.match(evidence, /AD260000095/);
  assert.ok(!codes(result.journeys[0].findings).includes('receipt-without-dumping'));
  const otherTruck = analyzeTransactions([previous, current, { ...wrong, EquipmentID: 99 }], rows, 'AD260000095');
  assert.ok(!codes(otherTruck.journeys[0].findings).includes('physical-pair-mismatch'));
  const ambiguous = analyzeTransactions([previous, current, wrong, { ...wrong, CTFinalTonnageID: 999 }], rows, 'AD260000095');
  assert.ok(codes(ambiguous.journeys[0].findings).includes('ambiguous-physical-pair'));
});

test('incomplete boundaries, unrelated readers, null dates and foreign CDN never invent complete journeys', () => {
  assert.equal(activityStage({ trans: 'Net Reader', ReaderLocationName: 'WB NORTH' }), 1);
  assert.equal(activityStage({ trans: 'Check Point', ReaderLocationName: 'MOBILE TOWER 1' }), 1);
  const open = analyzeTransactions([loading, dumping], events, 'TARGET').journeys[0];
  assert.deepEqual(open.counts, [1, 1, 1, 2, 1, 1]);
  assert.equal(open.candidates[0].basis, 'Urutan sebelum SK terbit');
  assert.ok(codes(open.findings).includes('pre-cdn-sequence'));
  assert.ok(codes(open.findings).includes('trip-closed'));
  assert.equal(open.end, at('12:30'));
  const bounded = analyzeTransactions([loading, next], [...events, event('Tol Gate', '11:05', { CoalDeliveryNumber: 'OTHER' }), event('Kirim - Muat', '11:06', { strTruckCN: 'OTHER', CoalDeliveryNumber: 'TARGET' }), { trans: 'Kirim - Muat', CoalDeliveryNumber: 'TARGET', dtTimeCollected: null }], 'TARGET').journeys[0];
  assert.equal(bounded.counts[2], 1);
  assert.ok(codes(bounded.findings).includes('undated-events'));
  assert.ok(codes(bounded.findings).includes('excluded-events'));
  assert.deepEqual(analyzeTransactions([{ ...loading, dtEmpty: null }], events, 'TARGET').journeys[0].counts, [1, 1, 1, 2, 1, 1]);
  assert.equal(analyzeTransactions([{ ...loading, dtEmpty: null }], [], 'TARGET').journeys[0].candidates.length, 0);
  assert.equal(analyzeTransactions([loading], events, 'MISSING').journeys.length, 0);
});
