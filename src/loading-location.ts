import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sql from 'mssql';

export const loadingLocationFields = ['LoadingLocationID', 'strStockPileName', 'CoalQualityID', 'CoalCalory', 'strCoalQualityName'] as const;
type Row = Record<string, unknown>;

// Sorted keys keep tokens independent of driver property order; dates retain database UTC values.
export function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    return item;
  });
}
export function loadingLocationToken(source: Row, candidate: Row, receipt: Row | null = null): string {
  return createHash('sha256').update(snapshot({ source, candidate, receipt })).digest('hex');
}
export function authDatabaseIdentifier(): string {
  const name = process.env.AUTH_DB_DATABASE || 'ITMonitor';
  if (!name.trim() || name.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Invalid audit database identifier');
  return `[${name.replace(/]/g, ']]')}]`;
}
export const loadingLocationSourceSql = (locked: boolean) => `SELECT * FROM dbo.tabCTFinalLoadingTonnage ${locked ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
  WHERE CTFinalLoadingTonnageID = @id AND dtDeletedAt IS NULL`;
export const loadingLocationReceiptSql = (locked: boolean) => `SELECT d.* FROM dbo.tabCTFinalDumpingTonnage d ${locked ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
  JOIN dbo.tabCTFinalLoadingTonnage k ${locked ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
    ON d.CTFinalDumpingTonnageID = k.CTFinalDumpingTonnageID WHERE k.CTFinalLoadingTonnageID = @id`;
export function loadingLocationCandidateSql(locked: boolean): string {
  const lock = locked ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  // Join source in SQL: no timestamp rounding or guessed decimal/string parameter types.
  return `SELECT TOP (1) WITH TIES l.LocationID AS LoadingLocationID, l.strLocationName AS strStockPileName,
    rr.CoalQualityID, cc.Coalcalory AS CoalCalory, cc.CoalQualityName AS strCoalQualityName, nr.dtcreatedAt AS readerAt
    FROM dbo.tabShiftNetReader nr ${lock}
    LEFT JOIN dbo.tabRFIDReader rr ${lock} ON rr.RFIDReaderID = nr.RFIDReaderID
    LEFT JOIN dbo.tabLocation l ${lock} ON l.LocationID = rr.LocationID
    LEFT JOIN dbo.tabCoalQualityAGM cc ${lock} ON cc.CoalQualityID = rr.CoalQualityID
    CROSS JOIN dbo.tabCTFinalLoadingTonnage source ${lock}
    WHERE source.CTFinalLoadingTonnageID = @id AND source.dtDeletedAt IS NULL
      AND nr.EquipmentID = source.EquipmentID AND nr.dtcreatedAt BETWEEN source.dtEmpty AND source.dtLoaded
    ORDER BY nr.dtcreatedAt DESC`;
}
export async function readLoadingLocation(request: sql.Request, locked: boolean) {
  const sources = (await request.query<Row>(loadingLocationSourceSql(locked))).recordset;
  if (!sources.length) throw new NotFoundException('Kirim aktif tidak ditemukan.');
  if (sources.length !== 1) throw new ConflictException('ID Kirim tidak unik.');
  const source = sources[0];
  if (source.strStockPileName !== null) throw new ConflictException('strStockPileName Kirim bukan NULL. Muat ulang dan periksa data.');
  const validId = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
  const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(+value);
  if (!validId(source.EquipmentID) || !validDate(source.dtEmpty) || !validDate(source.dtLoaded) || +source.dtEmpty > +source.dtLoaded) throw new ConflictException('Truck atau rentang waktu Kirim tidak valid.');
  const candidates = (await request.query<Row>(loadingLocationCandidateSql(locked))).recordset;
  if (!candidates.length) throw new NotFoundException('Reader dalam rentang timbang Kirim tidak ditemukan.');
  if (candidates.length !== 1) throw new ConflictException('Waktu reader terbaru sama pada beberapa baris; kandidat ambigu.');
  const candidate = candidates[0];
  if (!validId(candidate.LoadingLocationID) || !validId(candidate.CoalQualityID)
    || typeof candidate.CoalCalory !== 'number' || !Number.isFinite(candidate.CoalCalory) || candidate.CoalCalory < 0
    || !['strStockPileName', 'strCoalQualityName'].every(key => typeof candidate[key] === 'string' && (candidate[key] as string).trim().length > 0)
    || !validDate(candidate.readerAt)) throw new ConflictException('Reader terbaru memiliki lokasi atau kualitas batubara tidak lengkap. Tidak memakai reader sebelumnya.');
  let receipt: Row | null = null;
  if (source.CTFinalDumpingTonnageID !== null) {
    if (!validId(source.CTFinalDumpingTonnageID)) throw new ConflictException('Referensi Terima tidak valid.');
    const receipts = (await request.query<Row>(loadingLocationReceiptSql(locked))).recordset;
    if (receipts.length !== 1 || receipts[0].CTFinalDumpingTonnageID !== source.CTFinalDumpingTonnageID || receipts[0].dtDeletedAt !== null || receipts[0].EquipmentID !== source.EquipmentID)
      throw new ConflictException('Pasangan Terima hilang, ambigu, dihapus, atau berbeda truck.');
    receipt = receipts[0];
    if (!loadingLocationFields.every(key => Object.hasOwn(receipt!, key))) throw new ConflictException('Kolom lokasi/kualitas Terima tidak sesuai. Periksa struktur DB sebelum memperbarui.');
    const owners = (await request.query<Row>(`SELECT CTFinalLoadingTonnageID FROM dbo.tabCTFinalLoadingTonnage ${locked ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
      WHERE CTFinalDumpingTonnageID = (SELECT CTFinalDumpingTonnageID FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalLoadingTonnageID = @id) AND dtDeletedAt IS NULL`)).recordset;
    if (owners.length !== 1 || owners[0].CTFinalLoadingTonnageID !== source.CTFinalLoadingTonnageID)
      throw new ConflictException('Terima ditunjuk beberapa Kirim aktif. Perubahan dibatalkan.');
  }
  return { source, candidate, receipt, previewToken: loadingLocationToken(source, candidate, receipt) };
}
