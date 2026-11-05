/** Baris hasil procedure; nama kolom asli dipertahankan agar bukti mudah ditelusuri. */
export type Row = Record<string, string | number | boolean | null>;
export type Finding = {
  code: string;
  level: 'warn' | 'info';
  text: string
};
type Pair = {
  loading: Row;
  dumping: Row | undefined;
  unpairedDumping?: Row;
  findings: Finding[]
};
type Candidate = {
  row: Row;
  stage: number | null;
  time: number;
  basis: string
};
// Normalisasi label saja. TerimaRaw tetap bukan pasangan final transaksi Kirim.
export const transactionKind = (row: Row) => {
  const kind = String(row.Transaksi ?? '').trim();
  return ({ Loading: 'Kirim', Dumping: 'Terima', RawDumping: 'TerimaRaw', DumpingRaw: 'TerimaRaw', RawTerima: 'TerimaRaw' } as Record<string, string>)[kind] || kind;
};
export const isNewAssignment = (row: Row) => /^new[\s_-]+assignment$/i.test(String(row.trans ?? '').trim());
export const stages = ['Kosong Kirim', 'MT', 'Muat Kirim', 'Tollgate', 'Muat Terima', 'Kosong Terima'];
export const sameCdn = (row: Row, cdn: string) => typeof row.CoalDeliveryNumber === 'string' && row.CoalDeliveryNumber.trim().toUpperCase() === cdn.trim().toUpperCase();
const text = (value: Row[string] | undefined) => value === null || value === undefined || value === '' ? '—' : String(value);
const key = (value: Row[string] | undefined) => value === null || value === undefined || value === '' ? null : String(value).trim().toUpperCase();
// SQL datetime tanpa offset diperlakukan sebagai UTC untuk perbandingan stabil,
// bukan pernyataan bahwa jam operasional database memakai zona waktu UTC.
const timestamp = (value: Row[string] | undefined) => {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const iso = value.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso) ? iso : iso + 'Z');
};
// ponytail: penanda berdasarkan presisi waktu, bukan audit pembuat; gunakan metadata asal saat tersedia.
export const isDispatcherCreated = (row: Row) => {
  const time = row.dtTimeCollected;
  return ['Kirim', 'Terima'].includes(transactionKind(row)) && typeof time === 'string' &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]000(?:Z|[+-]\d{2}:\d{2})?$/i.test(time.trim()) && Number.isFinite(timestamp(time.replace(',', '.')));
};
// UserName diambil dari kolom procedure bila tersedia, bukan dari audit pembuat.
export const dispatcherLabel = (row: Row) => row.UserName ? `created by dispatcher : ${text(row.UserName)}` : 'created by dispatcher';
const truckMatches = (a: Row, b: Row) => {
  if (key(a.EquipmentID) !== null && key(b.EquipmentID) !== null) return key(a.EquipmentID) === key(b.EquipmentID);
  return key(a.strEquipmentName) !== null && key(a.strEquipmentName) === key(b.strEquipmentName);
};
export function activityStage(row: Row): number | null {
  const type = text(row.trans).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (['kirim kosong', 'kosong kirim'].includes(type)) return 0;
  if (['kirim muat', 'muat kirim'].includes(type)) return 2;
  if (['tol gate', 'toll gate', 'tollgate', 'tolgate'].includes(type)) return 3;
  if (['terima muat', 'muat terima'].includes(type)) return 4;
  if (['terima kosong', 'kosong terima'].includes(type)) return 5;
  if (['mt', 'mobiletower', 'mobile tower', 'net reader', 'netreader'].includes(type)) return 1;
  if (type === 'check point' && /\bMT(?=\d|\b)|mobile[\s_-]*tower/i.test(text(row.ReaderLocationName))) return 1;
  return null;
}
// ponytail: kelompok berdasarkan aktivitas satu truck, bukan relasi final DB; gunakan ID ritase resmi bila tersedia.
export function groupTruckActivities(rows: Row[]) {
  const ordered = rows.map((row, index) => ({ row, index, at: timestamp(row.dtTimeCollected) }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity) || a.index - b.index);
  const groups: typeof ordered[] = [];
  let current: typeof ordered = [];
  for (const item of ordered) {
    if (!Number.isFinite(item.at)) { groups.push([item]); current = []; continue; }
    if (!current.length && isNewAssignment(item.row)) { groups.push([item]); continue; }
    if (!current.length || activityStage(item.row) === 0) { current = []; groups.push(current); }
    current.push(item);
    if (activityStage(item.row) === 5) current = [];
  }
  return groups.map(items => {
    const events = items.map(item => item.row);
    if (events.every(isNewAssignment)) return {
      rows: events, sk: [] as string[], start: null, end: null,
      notes: items.some(item => !Number.isFinite(item.at)) ? ['Waktu tidak valid; posisi perubahan assignment tidak dapat ditentukan'] : [],
      status: 'Perubahan assignment',
    };
    const steps = events.map(activityStage);
    const start = steps[0] === 0 ? items[0].at : null;
    const end = steps.at(-1) === 5 ? items.at(-1)!.at : null;
    const sk = [...new Set(events.map(row => String(row.CoalDeliveryNumber ?? '').trim()).filter(Boolean))];
    const notes: string[] = [];
    if (start === null) notes.push('Awal ritase tidak terlihat');
    if (end === null) notes.push('Akhir ritase tidak terlihat');
    const missing = [0, 2, 3, 4, 5].filter(step => !steps.includes(step));
    if (missing.length) notes.push(`Tahap belum terlihat: ${missing.map(step => stages[step]).join(', ')}`);
    const known = steps.filter((step): step is number => step !== null);
    const reversed = known.some((step, i) => i > 0 && step < known[i - 1]);
    const repeated = known.some(step => step !== 1 && known.filter(value => value === step).length > (step === 3 ? 2 : 1));
    if (reversed) notes.push('Urutan tahap terbalik');
    if (repeated) notes.push('Tahap berulang; semua catatan tetap ditampilkan');
    if (sk.length > 1) notes.push('Lebih dari satu SK dalam kelompok');
    const unknown = events.some(row => activityStage(row) === null && !isNewAssignment(row));
    if (unknown) notes.push('Jenis aktivitas belum dikenali');
    if (items.some(item => !Number.isFinite(item.at))) notes.push('Waktu tidak valid; posisi ritase tidak dapat ditentukan');
    const review = reversed || repeated || sk.length > 1 || unknown || items.some(item => !Number.isFinite(item.at));
    return { rows: events, sk, start, end, notes, status: review ? 'Urutan perlu diperiksa' : missing.length ? 'Belum lengkap' : 'Lengkap' };
  });
}
/** Baca relasi tersimpan, bukan menebak pasangan berdasarkan CDN yang sama. */
function analyzePairs(loadings: Row[], dumpings: Row[]): Pair[] {
  return loadings.map(loading => {
    const findings: Finding[] = [];
    const add = (code: string, text: string, level: Finding['level'] = 'warn') => findings.push({ code, text, level });
    const ref = key(loading.RefDumpingTonnageID);
    const matches = ref === null ? [] : dumpings.filter(row => key(row.CTFinalTonnageID) === ref);
    const dumping = matches.length === 1 ? matches[0] : undefined;
    const previous = loadings.filter(row => row !== loading && truckMatches(row, loading) && timestamp(row.dtLoaded) < timestamp(loading.dtLoaded)).sort((a, b) => timestamp(b.dtLoaded) - timestamp(a.dtLoaded))[0];
    if (ref === null) add('no-reference', 'Kirim tidak memiliki RefDumpingTonnageID. Belum ada pasangan yang ditunjuk.');
    else if (!matches.length) add('unresolved-reference', `Terima #${ref} tidak muncul dalam hasil terbatas. Keberadaan pasangan belum terverifikasi.`, 'info');
    else if (matches.length > 1) add('ambiguous-reference', `ID Terima #${ref} muncul ${matches.length} kali; pasangan ambigu.`);
    if (dumping) {
      if (key(loading.CoalDeliveryNumber) === null || key(dumping.CoalDeliveryNumber) === null) add('missing-cdn', 'SK Kirim atau Terima kosong; kecocokan SK belum terverifikasi.', 'info');
      else if (key(loading.CoalDeliveryNumber) !== key(dumping.CoalDeliveryNumber)) {
        const earlier = loadings.some(row => truckMatches(row, loading) && sameCdn(row, text(dumping.CoalDeliveryNumber)) && timestamp(row.dtLoaded) < timestamp(loading.dtLoaded));
        add('cdn-mismatch', previous && sameCdn(previous, text(dumping.CoalDeliveryNumber)) ? 'Pasangan Terima memakai SK ritase sebelumnya yang terlihat pada hasil.' : earlier ? 'Pasangan Terima memakai SK ritase lebih awal yang terlihat pada hasil.' : 'SK pasangan Terima berbeda dari SK Kirim.');
      }
      if (key(loading.EquipmentID) !== null && key(dumping.EquipmentID) !== null && key(loading.EquipmentID) !== key(dumping.EquipmentID)) add('truck-mismatch', 'EquipmentID Kirim dan pasangan Terima berbeda.');
      if (timestamp(dumping.dtLoaded) < timestamp(loading.dtLoaded) || timestamp(dumping.dtEmpty) < timestamp(loading.dtLoaded)) add('dumping-before-loading', 'Waktu pasangan Terima lebih awal daripada waktu muat Kirim.');
      if (timestamp(dumping.dtEmpty) < timestamp(dumping.dtLoaded)) add('dumping-time-reversed', 'dtEmpty Terima lebih awal daripada dtLoaded.');
      if (dumping.dtDeletedAt) add('deleted-dumping', 'Pasangan Terima bertanda dihapus (dtDeletedAt terisi).');
    }
    if (ref !== null) {
      const other = loadings.filter(row => row !== loading && key(row.RefDumpingTonnageID) === ref);
      if (other.length) add('shared-reference', `Terima #${ref} juga ditunjuk Kirim lain: ${other.map(row => `${text(row.CoalDeliveryNumber)} / #${text(row.CTFinalTonnageID)}`).join(', ')}.`);
    }
    if (!dumping && dumpings.some(row => sameCdn(row, text(loading.CoalDeliveryNumber)))) add('cdn-only-candidate', 'Ada Terima dengan SK sama, tetapi tidak terhubung lewat RefDumpingTonnageID. Tidak dipasangkan otomatis.', 'info');
    return { loading, dumping, findings };
  });
}
export function groupTruckTransactions(rows: Row[]) {
  const ordered = rows.map((row, index) => ({ row, index, at: timestamp(row.dturutan ?? row.dtEmpty ?? row.dtLoaded) }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity) || a.index - b.index)
    .map(item => item.row);
  const loadings = ordered.filter(row => transactionKind(row) === 'Kirim');
  const dumpings = ordered.filter(row => transactionKind(row) === 'Terima');
  const pairs = analyzePairs(loadings, dumpings);
  const used = new Set<Row>();
  const groups: { rows: Row[]; sk: string[]; start: Row[string] | undefined; end: Row[string] | undefined; status: string; notes: string[] }[] = [];
  for (const row of ordered) {
    if (used.has(row)) continue;
    const pair = pairs.find(pair => pair.loading === row || (pair.dumping === row && !used.has(pair.loading) && !pair.findings.some(finding => finding.code === 'shared-reference')));
    const shared = pair?.findings.some(finding => finding.code === 'shared-reference');
    const members = pair ? [pair.loading, ...(!shared && pair.dumping ? [pair.dumping] : [])] : [row];
    members.forEach(member => used.add(member));
    const loading = members.find(member => transactionKind(member) === 'Kirim');
    const dumping = members.find(member => transactionKind(member) === 'Terima');
    const notes = pair ? pair.findings.map(finding => finding.text) : ['Transaksi tidak terhubung ke Kirim dalam hasil pencarian.'];
    groups.push({
      rows: members,
      sk: [...new Set(members.map(member => text(member.CoalDeliveryNumber)).filter(value => value !== '—'))],
      start: loading?.dtEmpty,
      end: dumping?.dtEmpty,
      status: pair?.findings.some(finding => finding.level === 'warn' && !['no-reference'].includes(finding.code)) ? 'Perlu diperiksa' : loading && dumping ? 'Terhubung' : 'Belum lengkap',
      notes,
    });
  }
  return groups;
}
/**
 * Rekonstruksi satu ritase dari aktivitas yang tersedia.
 * Temuan fisik juga ditambahkan ke pasangan pemilik referensi agar salah taut terlihat
 * pada kedua sisi. Baris transaksi/aktivitas masukan tidak pernah diubah.
 */
function analyzeJourney(pair: Pair, pairs: Pair[], loadings: Row[], dumpings: Row[], activities: Row[]) {
  const cdn = text(pair.loading.CoalDeliveryNumber);
  const findings: Finding[] = [];
  const add = (code: string, text: string, level: Finding['level'] = 'warn') => findings.push({ code, text, level });
  const loading = pair.loading;
  const loaded = timestamp(loading.dtLoaded);
  const truckEvents = activities
    .filter(row =>
      key(loading.strEquipmentName) !== null &&
      key(row.strTruckCN) === key(loading.strEquipmentName) &&
      Number.isFinite(timestamp(row.dtTimeCollected))
    )
    .sort((a, b) => timestamp(a.dtTimeCollected) - timestamp(b.dtTimeCollected));
  const anchor = truckEvents.find(row =>
    activityStage(row) === 2 &&
    sameCdn(row, cdn) &&
    Math.floor(timestamp(row.dtTimeCollected) / 1000) === Math.floor(loaded / 1000)
  );
  const before = anchor ? truckEvents.filter(row => timestamp(row.dtTimeCollected) < timestamp(anchor.dtTimeCollected)) : [];
  // 1. Muat Kirim menjadi jangkar jika truck, CDN, dan detik waktunya cocok.
  // MT/reader boleh menyela; timbang lain memutus hubungan ke Kosong Kirim sebelumnya.
  const previousWeighing = before.filter(row => [0, 2, 4, 5].includes(activityStage(row) ?? -1)).at(-1);
  const empty = previousWeighing && activityStage(previousWeighing) === 0 && (key(previousWeighing.CoalDeliveryNumber) === null || sameCdn(previousWeighing, cdn)) ? previousWeighing : undefined;
  const preCdn = new Set(empty && anchor
    ? truckEvents.filter(row =>
      timestamp(row.dtTimeCollected) >= timestamp(empty.dtTimeCollected) &&
      timestamp(row.dtTimeCollected) < timestamp(anchor.dtTimeCollected) &&
      (row === empty || activityStage(row) === 1) &&
      (key(row.CoalDeliveryNumber) === null || sameCdn(row, cdn))
    )
    : []
  );
  const start = empty
    ? timestamp(empty.dtTimeCollected)
    : previousWeighing
      ? Math.max(timestamp(loading.dtEmpty), timestamp(previousWeighing.dtTimeCollected) + 1000)
      : timestamp(loading.dtEmpty);
  const next = loadings
    .filter(row => row !== loading && truckMatches(row, loading) && timestamp(row.dtEmpty) > start)
    .sort((a, b) => timestamp(a.dtEmpty) - timestamp(b.dtEmpty))[0];
  const nextStart = next ? Math.floor(timestamp(next.dtEmpty) / 1000) * 1000 : Infinity;
  const restart = truckEvents.find(row =>
    timestamp(row.dtTimeCollected) > loaded &&
    (activityStage(row) === 0 ||
      (activityStage(row) === 2 && key(row.CoalDeliveryNumber) !== null && !sameCdn(row, cdn)))
  );
  const cutoff = Math.min(nextStart, restart ? timestamp(restart.dtTimeCollected) : Infinity);
  const closing = truckEvents.find(row =>
    activityStage(row) === 5 &&
    timestamp(row.dtTimeCollected) >= loaded &&
    timestamp(row.dtTimeCollected) < cutoff &&
    (key(row.CoalDeliveryNumber) === null || sameCdn(row, cdn))
  );
  const end = closing ? timestamp(closing.dtTimeCollected) : NaN;
  // 2. Awal ritase berikutnya menjadi batas eksklusif; Kosong Terima ikut ritase ini.
  // ponytail: Kosong Terima pertama yang terlihat menutup ritase; hasil procedure
  // terbatas tidak membuktikan penutup hilang. Gunakan query reader lengkap jika tersedia.
  const windowValid = Number.isFinite(start) && Number.isFinite(loaded) && loaded >= start && loaded < cutoff;
  if (!windowValid) add('invalid-window', 'Waktu Kirim tidak lengkap, terbalik, atau bertumpuk ritase berikutnya. Analisa urutan tidak dijalankan.', 'info');
  const candidates: Candidate[] = [];
  let excluded = 0;
  let undated = 0;
  if (windowValid) {
    for (const row of activities) {
      if (key(row.strTruckCN) !== null && key(loading.strEquipmentName) !== null && key(row.strTruckCN) !== key(loading.strEquipmentName)) {
        excluded++;
        continue;
      }
      const time = timestamp(row.dtTimeCollected);
      if (!Number.isFinite(time)) {
        undated++;
        continue;
      }
      // 3. Saring waktu, truck, dan CDN sebelum menghitung tahap.
      // Waktu awal dibulatkan ke detik; penutupan tetap memakai presisi asli.
      if (time < Math.floor(start / 1000) * 1000 || time >= cutoff || (Number.isFinite(end) && time > end)) continue;
      if (key(row.CoalDeliveryNumber) !== null && !sameCdn(row, cdn)) {
        excluded++;
        continue;
      }
      if (!sameCdn(row, cdn) && key(row.strTruckCN) !== key(loading.strEquipmentName)) {
        excluded++;
        continue;
      }
      candidates.push({
        row,
        stage: activityStage(row),
        time,
        basis: sameCdn(row, cdn)
          ? 'SK eksplisit'
          : preCdn.has(row)
            ? 'Urutan sebelum SK terbit'
            : closing
              ? 'Urutan ritase hingga Terima Kosong'
              : 'Kandidat ritase belum selesai',
      });
    }
    candidates.sort((a, b) => a.time - b.time);
    if (empty) add('pre-cdn-sequence', 'SK terbit pada Muat Kirim. Kosong Kirim terakhir sebelumnya pada truck yang sama, beserta MT di antaranya, masuk ritase SK ini walaupun kolom SK belum terisi.', 'info');
    if (closing) add('trip-closed', 'Terima Kosong menutup ritase SK ini dan ikut dihitung. Aktivitas setelahnya tidak dimasukkan, walaupun SK sama.', 'info');
    else {
      add('open-window', 'Terima Kosong belum terlihat; akhir ritase belum terverifikasi. Aktivitas tanpa SK masih kandidat ritase, dibatasi sebelum Kosong Kirim atau SK ritase berikutnya jika terlihat.', 'info');
      if (Number.isFinite(cutoff) || candidates.filter(event => event.stage === 2).length > 1) add('dispatch-before-receipt', 'Indikasi anomali: transaksi Kirim kembali atau ritase berikutnya sudah terlihat, tetapi Kosong Terima ritase SK ini belum terlihat. Periksa transaksi penutup; hasil procedure terbatas dapat menyembunyikan aktivitas tersebut.');
    }
    // 4. Bukti fisik harus cocok pada kedua waktu timbang, bukan hanya CDN.
    // Kandidat ini hanya menghasilkan temuan; pair.dumping tetap relasi tersimpan.
    // Jangkar/Kosong Kirim tidak wajib: aktivitas Kirim bisa tidak tersedia. Muat
    // Terima tetap wajib tidak mendahului dtLoaded; cutoff menutup ritase berikut.
    // Final berpresisi .000 dicocokkan pada detik yang sama dengan aktivitas.
    const sameWeighing = (finalTime: Row[string] | undefined, activityTime: Row[string] | undefined) => {
      const final = timestamp(finalTime);
      const activity = timestamp(activityTime);
      if (!Number.isFinite(final) || !Number.isFinite(activity)) return false;
      if (final === activity) return true;
      return new Date(final).getUTCMilliseconds() === 0 && Math.floor(final / 1000) === Math.floor(activity / 1000);
    };
    const received = candidates.filter(event => event.stage === 4 && event.time >= loaded);
    const physicalDumpings = closing
      ? dumpings.filter(row =>
        truckMatches(row, loading) &&
        !row.dtDeletedAt &&
        sameWeighing(row.dtEmpty, closing.dtTimeCollected) &&
        received.some(event => sameWeighing(row.dtLoaded, event.row.dtTimeCollected))
      )
      : [];
    if (physicalDumpings.length === 1) {
      const physical = physicalDumpings[0];
      const owners = loadings.filter(row => key(row.RefDumpingTonnageID) !== null && key(row.RefDumpingTonnageID) === key(physical.CTFinalTonnageID));
      if (key(loading.RefDumpingTonnageID) === null && !loading.dtDeletedAt && !owners.length && sameCdn(physical, cdn) &&
        loadings.filter(row => !row.dtDeletedAt && sameCdn(row, cdn) && truckMatches(row, physical)).length === 1) {
        pair.unpairedDumping = physical;
        const precision = timestamp(physical.dtLoaded) === timestamp(received.find(event => sameWeighing(physical.dtLoaded, event.row.dtTimeCollected))?.row.dtTimeCollected) &&
          timestamp(physical.dtEmpty) === timestamp(closing?.dtTimeCollected) ? '' : ' Pencocokan waktu dilakukan pada detik yang sama karena final berpresisi .000.';
        const note: Finding = { code: 'not-auto-paired', level: 'warn', text: `data tidak berpasangan otomatis. Kirim #${text(loading.CTFinalTonnageID)} dan Terima #${text(physical.CTFinalTonnageID)} cocok berdasarkan SK, truck, dan waktu timbang ritase, tetapi RefDumpingTonnageID Kirim kosong.${precision} Penyebab belum dipastikan; relasi tidak diubah.` };
        findings.push(note);
        pair.findings.push(note);
      } else if (pair.dumping !== physical || !sameCdn(physical, cdn)) {
        const evidence = `Terima #${text(physical.CTFinalTonnageID)} cocok dengan ritase SK ${cdn}: truck sama, dtLoaded ${text(physical.dtLoaded)} sama persis dengan Muat Terima dan dtEmpty ${text(physical.dtEmpty)} sama persis dengan Kosong Terima. SK Terima tersimpan ${text(physical.CoalDeliveryNumber)}; referensi Kirim ini ${text(loading.RefDumpingTonnageID)}. ${owners.length ? `Saat ini ditunjuk Kirim ${owners.map(row => `#${text(row.CTFinalTonnageID)} / ${text(row.CoalDeliveryNumber)}`).join(', ')}.` : 'Belum ditunjuk Kirim yang terlihat.'} Indikasi salah pasangan, bukan Terima hilang. Rekomendasi pemeriksaan, tanpa mengubah data otomatis.`;
        add('physical-pair-mismatch', evidence);
        pair.findings.push({ code: 'physical-pair-mismatch', level: 'warn', text: evidence });
        for (const owner of pairs.filter(other => other !== pair && owners.includes(other.loading))) owner.findings.push({ code: 'dumping-belongs-other-trip', level: 'warn', text: `Terima #${text(physical.CTFinalTonnageID)} yang ditunjuk referensi ini cocok persis dengan Muat Terima dan Kosong Terima ritase SK ${cdn} / Kirim #${text(loading.CTFinalTonnageID)}, bukan bukti pasangan benar untuk SK ${text(owner.loading.CoalDeliveryNumber)}.` });
      }
    } else if (physicalDumpings.length > 1) add('ambiguous-physical-pair', `${physicalDumpings.length} Terima memiliki truck dan waktu penerimaan yang sama. Kandidat pasangan ambigu; tidak dipilih otomatis.`);
    if (closing && pair.dumping && timestamp(pair.dumping.dtEmpty) !== end) {
      const evidence = `Referensi menunjuk Terima #${text(pair.dumping.CTFinalTonnageID)} dengan dtEmpty ${text(pair.dumping.dtEmpty)}, sedangkan ritase ini sudah ditutup Kosong Terima pada ${text(closing.dtTimeCollected)}. Waktu penutupan tidak cocok; periksa kemungkinan tertaut ke ritase lain.`;
      add('linked-dumping-close-mismatch', evidence);
      pair.findings.push({ code: 'linked-dumping-close-mismatch', level: 'warn', text: evidence });
    }
    if (closing && !pair.dumping && !physicalDumpings.length) {
      const sameCdnDumping = dumpings.some(row => sameCdn(row, cdn) && truckMatches(row, loading));
      if (sameCdnDumping) add('receipt-without-linked-dumping', 'Indikasi anomali: Kosong Terima terlihat dan ada Terima SK ini, tetapi pasangan melalui RefDumpingTonnageID belum terverifikasi. Terima seharusnya tergenerate bersamaan dengan Kosong Terima; periksa relasinya.');
      else add('receipt-without-dumping', 'Indikasi anomali: Kosong Terima terlihat, tetapi data Terima pasangan/SK ini tidak terlihat. Terima seharusnya tergenerate bersamaan dengan Kosong Terima. Periksa database; batas hasil procedure belum membuktikan Terima benar-benar tidak ada.');
    }
    if (candidates.some(event => event.basis === 'Urutan ritase hingga Terima Kosong')) add('inferred-events', 'Aktivitas tanpa SK pada truck yang sama, sejak Kosong Kirim hingga Terima Kosong, masuk ritase SK yang terbit saat Muat Kirim berdasarkan urutannya. Nilai SK asli tidak diubah.', 'info');
    if (excluded) add('excluded-events', `${excluded} aktivitas diabaikan karena SK/truck berbeda atau batas ritase belum terverifikasi.`, 'info');
    if (undated) add('undated-events', `${undated} aktivitas tidak memiliki waktu valid; urutannya belum terverifikasi.`, 'info');
    const unknown = candidates.filter(event => event.stage === null && !isNewAssignment(event.row));
    if (unknown.length) add('unknown-events', `${unknown.length} aktivitas belum dipetakan: ${[...new Set(unknown.map(event => `${text(event.row.trans)} / ${text(event.row.ReaderLocationName)}`))].join(', ')}. Check Point hanya dianggap MT jika nama lokasi menunjukkan mobile tower.`, 'info');
  }
  // 5. MT opsional, Tollgate boleh dua kali; tahap lain diharapkan sekali.
  // Waktu identik tidak dipaksa berurutan karena bukti tidak cukup membedakannya.
  const counts = stages.map((_, stage) => candidates.filter(event => event.stage === stage).length);
  if (windowValid) {
    counts.forEach((count, stage) => {
      if (stage === 1 && !count) add('optional-mt', 'MT opsional dan tidak terlihat pada hasil. Kosong Kirim langsung Muat Kirim tetap valid; operator dapat memilih asal batu secara manual di timbangan. Hasil ini tidak membuktikan pemilihan manual.', 'info');
      else if (!count) add(`missing-${stage}`, `${stages[stage]} belum terlihat pada hasil untuk ritase ini; kelengkapan belum terverifikasi.`, 'info');
      else if (count > (stage === 3 ? 2 : stage === 1 ? Infinity : 1)) add(`duplicate-${stage}`, `${stages[stage]} tercatat ${count}x ${candidates.some(event => event.stage === stage && key(event.row.CoalDeliveryNumber) === null) ? 'pada kandidat ritase' : 'dengan SK ini'}. Periksa pembacaan ganda atau ritase tertumpuk.`);
    });
    let highest = -1;
    let highestTime = -Infinity;
    for (const event of candidates) {
      if (event.stage === null) continue;
      if (event.stage < highest && event.time > highestTime) add('out-of-order', `${stages[event.stage]} pada ${text(event.row.dtTimeCollected)} muncul setelah ${stages[highest]}. Urutan kandidat tidak sesuai.`);
      if (event.stage > highest) {
        highest = event.stage;
        highestTime = event.time;
      }
    }
    if (counts.every((count, stage) => stage === 1 || count > 0) && !findings.some(finding => finding.level === 'warn')) add('sequence-observed', 'Tahap wajib terlihat dalam urutan yang diharapkan; MT opsional. Bukan jaminan data lengkap di luar hasil procedure.', 'info');
  }
  return {
    loading,
    start: Number.isFinite(start) ? new Date(start).toISOString() : null,
    end: Number.isFinite(end) ? new Date(end).toISOString() : null,
    counts,
    candidates,
    findings,
  };
}
/**
 * Analisa hanya membaca snapshot hasil procedure, tanpa query atau perbaikan data.
 * Semua Kirim diperiksa lebih dahulu: ritase pembanding dapat mengungkap referensi
 * yang salah milik. Hanya daftar journeys yang dibatasi ke CDN pencarian.
 */
export function analyzeTransactions(transactions: Row[], activities: Row[], cdn: string) {
  const loadings = transactions.filter(row => transactionKind(row) === 'Kirim');
  const dumpings = transactions.filter(row => transactionKind(row) === 'Terima');
  const pairs = analyzePairs(loadings, dumpings);
  const journeys = pairs.map(pair => analyzeJourney(pair, pairs, loadings, dumpings, activities));
  return { pairs, journeys: journeys.filter(journey => sameCdn(journey.loading, cdn)) };
}
