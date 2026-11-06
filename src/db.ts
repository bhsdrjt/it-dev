import { ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import { authDatabaseIdentifier, loadingLocationCandidateSql, loadingLocationFields, loadingLocationSourceSql, loadingLocationReceiptSql, readLoadingLocation, snapshot } from './loading-location';
// Nilai parameter dirender sebagai literal agar query di Activity Log dapat dibaca dan dijalankan ulang.
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}
type SqlParameters = Record<string, { value?: unknown }>;
function parametersOf(request: sql.Request): SqlParameters {
  return (request as unknown as { parameters?: SqlParameters }).parameters ?? {};
}
export type Equipment = {
  EquipmentID: number;
  strTruckCN: string
};
export type Location = {
  LocationID: number;
  strLocationName: string
};
export type CoalCalory = {
  CoalQualityAGMID: number;
  CoalQualityID: number;
  CoalQualityName: string | null;
  Coalcalory: number | null;
  dtUpdatedAt: Date | null
};
@Injectable()
export class DbService implements OnModuleDestroy {
  private pool?: sql.ConnectionPool;
  private connecting?: Promise<sql.ConnectionPool>;
  private readonly logger = new Logger(DbService.name);
  // Trace berlaku per request HTTP: request serentak tidak saling menimpa daftar query.
  private readonly traces = new AsyncLocalStorage<string[]>();
  private formatQuery(statement: string, request: sql.Request): string {
    const parameters = parametersOf(request);
    const filled = statement.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (token, name: string) => Object.prototype.hasOwnProperty.call(parameters, name) ? sqlLiteral(parameters[name]?.value) : token);
    return filled.replace(/\s+/g, ' ').trim();
  }
  private formatExecute(procedure: string, request: sql.Request): string {
    const args = Object.entries(parametersOf(request)).map(([name, parameter]) => `@${name} = ${sqlLiteral(parameter?.value)}`);
    return args.length ? `EXEC ${procedure} ${args.join(', ')}` : `EXEC ${procedure}`;
  }
  // Bungkus request yang dibuat di dalam withQueries agar setiap statement tercatat.
  private traced(request: sql.Request): sql.Request {
    const trace = this.traces.getStore();
    if (!trace) return request;
    const query = request.query as unknown as (statement: string, ...args: unknown[]) => unknown;
    const execute = request.execute as unknown as (procedure: string, ...args: unknown[]) => unknown;
    if (typeof query === 'function') {
      request.query = ((statement: string, ...args: unknown[]) => {
        trace.push(this.formatQuery(statement, request));
        return query.call(request, statement, ...args);
      }) as unknown as sql.Request['query'];
    }
    if (typeof execute === 'function') {
      request.execute = ((procedure: string, ...args: unknown[]) => {
        trace.push(this.formatExecute(procedure, request));
        return execute.call(request, procedure, ...args);
      }) as unknown as sql.Request['execute'];
    }
    return request;
  }
  private async withQueries<T extends object>(action: () => Promise<T>): Promise<T & { queries: string[] }> {
    const queries: string[] = [];
    try {
      const result = await this.traces.run(queries, action);
      return { ...result, queries };
    } catch (error) {
      // Sertakan query yang sempat berjalan agar kegagalan juga dapat diperiksa dari Activity Log.
      if (error instanceof HttpException) {
        const detail = error.getResponse();
        const body = typeof detail === 'string' ? { message: detail } : detail as object;
        throw new HttpException({ ...body, queries }, error.getStatus());
      }
      throw error;
    }
  }
  // Semua request serentak menunggu promise koneksi yang sama agar pool tidak berlipat.
  // Koneksi dibuat saat dibutuhkan; database offline tidak menggagalkan startup UI.
  private async connect(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (this.connecting) return this.connecting;
    const pool = new sql.ConnectionPool({
      server: process.env.DB_SERVER!, database: process.env.DB_DATABASE!,
      user: process.env.DB_USER!, password: process.env.DB_PASSWORD!,
      port: Number(process.env.DB_PORT || 1433), connectionTimeout: 5000, requestTimeout: 10000,
      pool: { min: 0, max: 10, idleTimeoutMillis: 30000 },
      options: { encrypt: process.env.DB_ENCRYPT !== 'false', trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true' },
    });
    pool.on('error', error => {
      this.logger.error('SQL pool error', error);
      if (this.pool === pool) this.pool = undefined;
      void pool.close().catch(() => undefined);
    });
    this.connecting = pool.connect().then(connected => {
      this.pool = connected;
      return connected;
    });
    try {
      return await this.connecting;
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw error;
    } finally {
      // Permintaan berikutnya boleh mencoba koneksi baru setelah percobaan selesai.
      this.connecting = undefined;
    }
  }
  private async read<T>(action: (request: sql.Request) => Promise<T>): Promise<T> {
    let pool: sql.ConnectionPool | undefined;
    try {
      pool = await this.connect();
      return await action(this.traced(pool.request()));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('SQL query failed', error);
      if (pool && (!pool.connected || ['ESOCKET', 'ECONNCLOSED', 'ENOCONN'].includes((error as {
        code?: string
      }).code || ''))) {
        if (this.pool === pool) this.pool = undefined;
        await pool.close().catch(() => undefined);
      }
      throw new ServiceUnavailableException('Database pusat tidak tersedia. Coba lagi atau hubungi administrator.');
    }
  }
  private query<T>(statement: string, id?: number): Promise<T[]> {
    return this.read(async request => {
      if (id !== undefined) request.input('id', sql.Int, id);
      return (await request.query<T>(statement)).recordset;
    });
  }
  truckHistory(equipmentId: number, starttime: Date, endtime: Date) {
    return this.withQueries(() => this.read(async request => {
      (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
      // SQL DATETIME adalah jam database, bukan zona waktu browser; mssql mengirim komponen UTC.
      request.input('EquipmentID', sql.Int, equipmentId).input('starttime', sql.DateTime, starttime).input('endtime', sql.DateTime, endtime);
      const result = await request.execute('dbo.spTruckTransactionHistory');
      const sets = result.recordsets as sql.IRecordSet<Record<string, unknown>>[];
      return { equipmentId, starttime, endtime, transactions: sets[0] || [], activities: sets[1] || [] };
    }));
  }
  truckTimeline(coalDeliveryNumber: string) {
    return this.withQueries(() => this.read(async request => {
      // Timeline lebih berat: timeout 60 detik hanya untuk request ini, bukan seluruh pool.
      // mssql 12 mendukung overrides, tetapi @types/mssql belum mendeklarasikannya.
      (request as sql.Request & {
        overrides: {
          requestTimeout?: number
        }
      }).overrides.requestTimeout = 60000;
      request.input('CoalDeliveryNumber', sql.VarChar(50), coalDeliveryNumber);
      try {
        const result = await request.execute('dbo.usp_GetTruckTimelineByCoalDelivery');
        const sets = result.recordsets as sql.IRecordSet<Record<string, unknown>>[];
        return { coalDeliveryNumber, transactions: sets[0] || [], activities: sets[1] || [] };
      } catch (error) {
        if ((error as {
          number?: number
        }).number === 50001) throw new NotFoundException('Data tidak ditemukan untuk CoalDeliveryNumber tersebut.');
        throw error;
      }
    }));
  }
  promoteRawDumping(rawTonnageId: number) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction));
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        request.input('id', sql.Int, rawTonnageId);
        // Lock baris raw yang dipilih; CDN yang sama boleh memiliki beberapa raw.
        const raw = (await request.query(`SELECT EquipmentID, dtTimeCollected, dtDeletedAt
          FROM dbo.tabCTFinalDumpingTonnageRaw WITH (UPDLOCK, HOLDLOCK)
          WHERE CTFinalDumpingTonnageRawID = @id`)).recordset;
        if (!raw.length) throw new NotFoundException(`RawTerima #${rawTonnageId} tidak ditemukan.`);
        if (raw.length !== 1) throw new ConflictException('ID RawTerima tidak unik; periksa database.');
        if (raw[0].dtDeletedAt != null || raw[0].EquipmentID == null || raw[0].dtTimeCollected == null) throw new ConflictException('RawTerima dihapus atau identitas/waktunya tidak lengkap.');
        request.input('EquipmentID', sql.Int, raw[0].EquipmentID);
        request.input('dtTimeCollected', sql.DateTime, raw[0].dtTimeCollected);
        const existing = (await request.query(`SELECT TOP (1) CTFinalDumpingTonnageID
          FROM dbo.tabCTFinalDumpingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE EquipmentID = @EquipmentID AND dtTimeCollected = @dtTimeCollected`)).recordset;
        if (existing.length) throw new ConflictException('Terima untuk truck dan waktu raw ini sudah ada, termasuk data yang dihapus. Muat ulang dan periksa sebelum memproses lagi.');
        // Request terpisah: hanya parameter yang dideklarasikan procedure dikirim.
        const replay = this.traced(new sql.Request(transaction));
        (replay as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        await replay.input('id', sql.Int, rawTonnageId).execute('dbo.usp_DebugCTFinalDumpingTonnagebyID');
        const inserted = (await request.query(`SELECT CTFinalDumpingTonnageID
          FROM dbo.tabCTFinalDumpingTonnage
          WHERE EquipmentID = @EquipmentID AND dtTimeCollected = @dtTimeCollected AND dtDeletedAt IS NULL`)).recordset;
        if (inserted.length !== 1) throw new ConflictException('Procedure tidak menghasilkan tepat satu Terima aktif. Perubahan dibatalkan.');
        await transaction.commit();
        this.logger.log(`RawTerima #${rawTonnageId} diproses menjadi Terima #${inserted[0].CTFinalDumpingTonnageID}.`);
        return { message: `RawTerima #${rawTonnageId} berhasil diproses menjadi Terima #${inserted[0].CTFinalDumpingTonnageID}.` };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(rollbackError => this.logger.error('RawTerima rollback failed', rollbackError));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('RawTerima replay failed', error);
        throw new ServiceUnavailableException('Pemrosesan RawTerima gagal atau hasilnya belum dapat dipastikan. Muat ulang dan periksa data sebelum mencoba lagi; jangan langsung mengulang.');
      }
    });
  }
  async transactionDetail(kind: 'Kirim' | 'Terima', id: number) {
    const rows = await this.query<Record<string, unknown>>(kind === 'Kirim'
      ? 'SELECT * FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalLoadingTonnageID = @id'
      : 'SELECT * FROM dbo.tabCTFinalDumpingTonnage WHERE CTFinalDumpingTonnageID = @id', id);
    if (!rows.length) throw new NotFoundException('Detail transaksi tidak ditemukan.');
    if (rows.length !== 1) throw new ConflictException('ID transaksi tidak unik.');
    return rows[0];
  }
  relatedTransactions(kind: 'Kirim' | 'Terima', dumpingTonnageId: number) {
    return this.query<Record<string, unknown>>(kind === 'Kirim'
      ? 'SELECT * FROM dbo.tabCTFinalDumpingTonnage WHERE CTFinalDumpingTonnageID = @id'
      : 'SELECT * FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalDumpingTonnageID = @id', dumpingTonnageId);
  }
  previewLoadingLocation(loadingTonnageId: number) {
    return this.withQueries(() => this.read(request => readLoadingLocation(request.input('id', sql.Int, loadingTonnageId), false)));
  }
  updateLoadingLocation(loadingTonnageId: number, previewToken: string, actorUserId: number) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        const auditDatabase = authDatabaseIdentifier();
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        const request = this.traced(new sql.Request(transaction).input('id', sql.Int, loadingTonnageId));
        const before = await readLoadingLocation(request, true);
        if (before.previewToken !== previewToken.toLowerCase()) throw new ConflictException('Sumber atau kandidat berubah sejak preview. Muat ulang preview sebelum menyimpan.');
        // Reread authoritative values under held locks; preserve SQL string lengths and numeric precision.
        const updated = await request.query(`DECLARE @changed TABLE (id int);
          ;WITH candidate AS (${loadingLocationCandidateSql(true)})
          UPDATE target SET LoadingLocationID = candidate.LoadingLocationID,
            strStockPileName = candidate.strStockPileName, CoalQualityID = candidate.CoalQualityID,
            CoalCalory = candidate.CoalCalory, strCoalQualityName = candidate.strCoalQualityName
          OUTPUT inserted.CTFinalLoadingTonnageID INTO @changed
          FROM dbo.tabCTFinalLoadingTonnage target CROSS JOIN candidate
          WHERE target.CTFinalLoadingTonnageID = @id AND target.dtDeletedAt IS NULL AND target.strStockPileName IS NULL;
          SELECT COUNT(*) AS changed FROM @changed;`);
        if (updated.recordset?.[0]?.changed !== 1) throw new ConflictException('Perubahan tidak menghasilkan tepat satu Kirim. Perubahan dibatalkan.');
        const after = (await request.query<Record<string, unknown>>(loadingLocationSourceSql(true))).recordset;
        const expected = { ...before.source, ...Object.fromEntries(loadingLocationFields.map(key => [key, before.candidate[key]])) };
        // Full row snapshot protects truck, SK, weights, timestamps and references without guessing column names.
        if (after.length !== 1 || snapshot(after[0]) !== snapshot(expected)) throw new ConflictException('Hasil perubahan atau kolom Kirim yang dilindungi tidak sesuai. Perubahan dibatalkan.');
        let receiptAfter: Record<string, unknown> | null = null;
        if (before.receipt) {
          const receiptUpdated = await request.query(`DECLARE @changed TABLE (id int);
            UPDATE d SET LoadingLocationID = k.LoadingLocationID, strStockPileName = k.strStockPileName,
              CoalQualityID = k.CoalQualityID, CoalCalory = k.CoalCalory, strCoalQualityName = k.strCoalQualityName
            OUTPUT inserted.CTFinalDumpingTonnageID INTO @changed
            FROM dbo.tabCTFinalDumpingTonnage d JOIN dbo.tabCTFinalLoadingTonnage k
              ON d.CTFinalDumpingTonnageID = k.CTFinalDumpingTonnageID
            WHERE k.CTFinalLoadingTonnageID = @id AND d.dtDeletedAt IS NULL;
            SELECT COUNT(*) AS changed FROM @changed;`);
          if (receiptUpdated.recordset?.[0]?.changed !== 1) throw new ConflictException('Update pasangan Terima gagal. Seluruh perubahan dibatalkan.');
          const receipts = (await request.query<Record<string, unknown>>(loadingLocationReceiptSql(true))).recordset;
          const expectedReceipt = { ...before.receipt, ...Object.fromEntries(loadingLocationFields.map(key => [key, before.candidate[key]])) };
          if (receipts.length !== 1 || snapshot(receipts[0]) !== snapshot(expectedReceipt)) throw new ConflictException('Hasil Terima tidak sesuai. Seluruh perubahan dibatalkan.');
          receiptAfter = receipts[0];
          const sourceAgain = (await request.query<Record<string, unknown>>(loadingLocationSourceSql(true))).recordset;
          if (sourceAgain.length !== 1 || snapshot(sourceAgain[0]) !== snapshot(expected)) throw new ConflictException('Kirim berubah saat sinkronisasi Terima. Seluruh perubahan dibatalkan.');
        }
        const operationId = randomBytes(16).toString('hex');
        await this.traced(new sql.Request(transaction))
          .input('actor', sql.Int, actorUserId).input('action', sql.NVarChar(100), 'loading_location.update')
          .input('target', sql.NVarChar(sql.MAX), snapshot({ loadingTonnageId, before: before.source, after: after[0], receiptBefore: before.receipt, receiptAfter, readerAt: before.candidate.readerAt }))
          .input('operation', sql.VarChar(32), operationId).input('outcome', sql.VarChar(20), 'succeeded')
          .query(`INSERT ${auditDatabase}.dbo.UserAudit(ActorUserId,Action,Target,OperationId,Outcome)
            VALUES(@actor,@action,@target,@operation,@outcome)`);
        await transaction.commit();
        return { message: `LoadingLocation Kirim #${loadingTonnageId}${before.receipt ? ` dan Terima #${before.receipt.CTFinalDumpingTonnageID}` : ' (tanpa pasangan Terima)'} berhasil diperbarui.`, operationId };
      } catch (error) {
        if (transaction && !rolledBack) {
          try { await transaction.rollback(); }
          catch (cause) {
            this.logger.error('LoadingLocation rollback failed', cause);
            throw new ServiceUnavailableException('Hasil Get LoadingLocation belum dapat dipastikan. Muat ulang dan periksa data sebelum mencoba kembali.');
          }
        }
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('LoadingLocation update failed', error);
        throw new ServiceUnavailableException('Hasil Get LoadingLocation belum dapat dipastikan. Muat ulang dan periksa data sebelum mencoba kembali.');
      }
    });
  }
  pairLoadingRelation(loadingTonnageId: number) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction));
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        request.input('CTFinalLoadingTonnageID', sql.Int, loadingTonnageId);
        const current = (await request.query(`SELECT CTFinalDumpingTonnageID, EquipmentID, dtLoaded, dtDeletedAt
          FROM dbo.tabCTFinalLoadingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE CTFinalLoadingTonnageID = @CTFinalLoadingTonnageID`)).recordset[0];
        if (!current) throw new NotFoundException('Kirim tersebut tidak ditemukan.');
        if (current.CTFinalDumpingTonnageID != null) throw new ConflictException('Kirim sudah memiliki relasi. Muat ulang; lepas relasi terlebih dahulu jika diperlukan.');
        if (current.dtDeletedAt != null || current.EquipmentID == null || current.dtLoaded == null) throw new ConflictException('Kirim dihapus atau truck/waktu muat tidak lengkap.');
        request.input('EquipmentID', sql.Int, current.EquipmentID);
        request.input('dtLoaded', sql.DateTime, current.dtLoaded);
        // Ikuti urutan procedure persis; dua baris cukup untuk mendeteksi pilihan pertama ambigu.
        const candidates = (await request.query(`SELECT TOP (2) CTFinalDumpingTonnageID, dtEmpty
          FROM dbo.tabCTFinalDumpingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE EquipmentID = @EquipmentID AND dtEmpty >= @dtLoaded AND dtDeletedAt IS NULL
          ORDER BY dtEmpty ASC`)).recordset;
        if (!candidates.length) throw new ConflictException('Terima aktif setelah muat Kirim tidak ditemukan untuk truck ini.');
        if (candidates[0].dtEmpty == null || (candidates.length > 1 && +candidates[0].dtEmpty === +candidates[1].dtEmpty)) throw new ConflictException('Urutan Terima pertama ambigu atau waktunya kosong. Periksa database.');
        const dumpingId = candidates[0].CTFinalDumpingTonnageID;
        request.input('CTFinalDumpingTonnageID', sql.Int, dumpingId);
        const owners = (await request.query(`SELECT TOP (1) CTFinalLoadingTonnageID, dtDeletedAt
          FROM dbo.tabCTFinalLoadingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE CTFinalDumpingTonnageID = @CTFinalDumpingTonnageID AND dtDeletedAt IS NULL`)).recordset;
        if (owners.length) throw new ConflictException(`Terima #${dumpingId} masih ditunjuk Kirim aktif #${owners[0].CTFinalLoadingTonnageID}. Periksa dan lepas relasi lama jika memang sesuai sebelum memasangkan ulang. Relasi tidak diubah.`);
        const pairing = this.traced(new sql.Request(transaction));
        (pairing as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        await pairing.input('CTFinalLoadingTonnageID', sql.Int, loadingTonnageId).execute('dbo.sp_UpdateCTFinalDumpingTonnageIDManualByID');
        const linked = (await request.query(`SELECT CTFinalDumpingTonnageID FROM dbo.tabCTFinalLoadingTonnage
          WHERE CTFinalLoadingTonnageID = @CTFinalLoadingTonnageID`)).recordset[0];
        if (linked?.CTFinalDumpingTonnageID !== dumpingId) throw new ConflictException('Hasil procedure tidak sesuai kandidat Terima. Perubahan dibatalkan.');
        await transaction.commit();
        const message = `Kirim #${loadingTonnageId} berhasil dipasangkan dengan Terima #${dumpingId}.`;
        this.logger.log(message);
        return { message };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(rollbackError => this.logger.error('Pair relation rollback failed', rollbackError));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('Pair relation failed', error);
        throw new ServiceUnavailableException('Pemasangan relasi gagal atau hasilnya belum dapat dipastikan. Muat ulang dan periksa data sebelum mencoba lagi; jangan langsung mengulang.');
      }
    });
  }
  releaseLoadingRelation(loadingTonnageId: number) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction));
        request.input('CTFinalLoadingTonnageID', sql.Int, loadingTonnageId);
        const current = (await request.query(`SELECT TOP (1) CTFinalDumpingTonnageID, CoalDeliveryNumber
          FROM dbo.tabCTFinalLoadingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE CTFinalLoadingTonnageID = @CTFinalLoadingTonnageID`)).recordset;
        if (!current.length) throw new NotFoundException('Kirim tersebut tidak ditemukan.');
        if (current[0].CTFinalDumpingTonnageID == null) throw new ConflictException('Kirim ini sudah tidak memiliki relasi Terima.');
        const updated = await request.query(`UPDATE dbo.tabCTFinalLoadingTonnage
          SET CTFinalDumpingTonnageID = NULL
          WHERE CTFinalLoadingTonnageID = @CTFinalLoadingTonnageID AND CTFinalDumpingTonnageID IS NOT NULL`);
        if (updated.rowsAffected[0] !== 1) throw new ConflictException('Relasi tidak berubah; periksa data sebelum mencoba lagi.');
        await transaction.commit();
        const message = `Relasi Terima #${current[0].CTFinalDumpingTonnageID} dilepas dari Kirim #${loadingTonnageId} (SK ${current[0].CoalDeliveryNumber ?? '—'}).`;
        this.logger.log(message);
        return { message };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(rollbackError => this.logger.error('Release relation rollback failed', rollbackError));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('Release relation failed', error);
        throw new ServiceUnavailableException('Pelepasan relasi gagal atau hasilnya belum dapat dipastikan. Muat ulang dan periksa data sebelum mencoba lagi; jangan langsung mengulang.');
      }
    });
  }
  salinMuatanCandidates(coalDeliveryNumber: string, nextDT: string) {
    return this.withQueries(() => this.read(async request => {
      // Pemeriksaan kandidat read-only pada tabel besar: timeout longgar + NOLOCK agar tidak menunggu transaksi tulis timbangan.
      (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 30000;
      request.input('cdn', sql.VarChar(20), coalDeliveryNumber);
      const sources = (await request.query(`SELECT TOP (1) EquipmentID, dtLoaded
        FROM dbo.tabCTFinalLoadingTonnage WITH (NOLOCK)
        WHERE CoalDeliveryNumber = @cdn
        ORDER BY dtLoaded DESC`)).recordset;
      if (!sources.length) throw new NotFoundException('Kirim sumber tidak ditemukan.');
      if (sources[0].dtLoaded == null) throw new NotFoundException('Kirim sumber tidak memiliki dtLoaded.');
      request.input('nextDT', sql.VarChar(8), nextDT);
      const trucks = (await request.query(`SELECT TOP (1) EquipmentID
        FROM dbo.tabEquipment WITH (NOLOCK) WHERE strTruckCN = @nextDT`)).recordset;
      if (!trucks.length) throw new NotFoundException('Truck penyalin tidak ditemukan.');
      request.input('eq', sql.Int, trucks[0].EquipmentID).input('dtLoaded', sql.DateTime, sources[0].dtLoaded);
      // Kandidat: Terima aktif truck penyalin yang belum ditunjuk Kirim mana pun dalam jendela 3 hari.
      const candidates = (await request.query(`SELECT TOP (1)
          d.CTFinalDumpingTonnageID, d.CoalDeliveryNumber, d.dtLoaded, d.dtEmpty
        FROM dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
        WHERE d.EquipmentID = @eq
          AND d.dtEmpty >= @dtLoaded
          AND d.dtEmpty <= DATEADD(DAY, 3, @dtLoaded)
          AND d.dtDeletedAt IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
            WHERE l.CTFinalDumpingTonnageID = d.CTFinalDumpingTonnageID
              AND l.dtLoaded < DATEADD(DAY, 3, d.dtEmpty)
          )
        ORDER BY d.dtEmpty ASC`)).recordset;
      // Pratinjau Terima baru yang akan dibuat usp_SalinMuatan saat tidak ada kandidat.
      // Hanya tampilan: procedure menghitung ulang saat eksekusi.
      let preview: { dtEmpty: unknown; dtLoaded: unknown; flEmptyTonnage: unknown; flLoadedTonnage: unknown } | null = null;
      if (!candidates.length) {
        const empty = (await request.query(`SELECT TOP (1)
            d.dtTimeCollected AS dtEmpty, d.flTonnage AS flEmptyTonnage
          FROM dbo.tabCTDumpEmpty AS d WITH (NOLOCK)
          WHERE d.EquipmentID = @eq
            AND d.dtTimeCollected >= @dtLoaded
            AND d.dtTimeCollected <= DATEADD(DAY, 4, @dtLoaded)
            AND NOT EXISTS (
              SELECT 1 FROM dbo.tabCTFinalDumpingTonnage AS f WITH (NOLOCK)
              WHERE f.EquipmentID = d.EquipmentID
                AND f.dtEmpty > @dtLoaded
                AND f.dtEmpty = d.dtTimeCollected
                AND f.dtEmpty <= DATEADD(DAY, 4, @dtLoaded)
            )
          ORDER BY d.dtTimeCollected ASC`)).recordset;
        if (empty.length) {
          request.input('previewEmpty', sql.DateTime, empty[0].dtEmpty);
          const loaded = (await request.query(`SELECT TOP (1)
              d.dtTimeCollected AS dtLoaded, d.flTonnage AS flLoadedTonnage
            FROM dbo.tabCTDumpLoaded AS d WITH (NOLOCK)
            WHERE d.EquipmentID = @eq
              AND d.dtTimeCollected <= @previewEmpty
            ORDER BY d.dtTimeCollected DESC`)).recordset;
          preview = {
            dtEmpty: empty[0].dtEmpty,
            flEmptyTonnage: empty[0].flEmptyTonnage,
            dtLoaded: loaded[0]?.dtLoaded ?? null,
            flLoadedTonnage: loaded[0]?.flLoadedTonnage ?? null
          };
        }
      }
      return { coalDeliveryNumber, nextDT, source: sources[0], candidates, preview };
    }));
  }
  salinMuatanKeTerimaAda(coalDeliveryNumber: string, nextDT: string, dumpingTonnageId: number) {
    return this.withQueries(async () => {
      let pool: sql.ConnectionPool | undefined;
      try {
        pool = await this.connect();
        // Eksekusi Salin Muatan ke SK terima yang sudah ada; aturan ada di procedure.
        const request = this.traced(pool.request());
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        const result = await request
          .input('CoalDeliveryNumberNya', sql.VarChar(20), coalDeliveryNumber)
          .input('NoTruck', sql.VarChar(8), nextDT)
          .input('CTFinalDumpingTonnageID', sql.Int, dumpingTonnageId)
          .execute('dbo.usp_SalinMuatanKeTerimaAda');
        const message = String(result.recordset?.[0]?.Pesan ?? `Salin Muatan SK ${coalDeliveryNumber} ke Terima #${dumpingTonnageId} (truck ${nextDT}) berhasil melalui dbo.usp_SalinMuatanKeTerimaAda.`);
        this.logger.log(message);
        return { message };
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const number = (error as { number?: number }).number;
        if (number === 50010 || number === 50011) throw new NotFoundException('Kirim sumber tidak ditemukan atau dtLoaded kosong.');
        if (number === 50012) throw new NotFoundException('Truck penyalin tidak ditemukan.');
        if (number === 50013) throw new ConflictException('SK terima tidak ditemukan.');
        if (number === 50017) throw new ConflictException('Update Kirim gagal; jumlah baris tidak sesuai.');
        this.logger.error('Salin Muatan ke Terima Ada failed', error);
        if (pool && (!pool.connected || ['ESOCKET', 'ECONNCLOSED', 'ENOCONN'].includes((error as { code?: string }).code || ''))) {
          if (this.pool === pool) this.pool = undefined;
          await pool.close().catch(() => undefined);
        }
        throw new ServiceUnavailableException('Hasil Salin Muatan belum dapat dipastikan. Muat ulang dan periksa sebelum mengulang.');
      }
    });
  }
  salinMuatan(coalDeliveryNumber: string, nextDT: string) {
    return this.withQueries(async () => {
      let pool: sql.ConnectionPool;
      try {
        pool = await this.connect();
      } catch (error) {
        this.logger.error('Salin Muatan connection failed', error);
        throw new ServiceUnavailableException('Database pusat tidak tersedia. Coba lagi atau hubungi administrator.');
      }
      try {
        // Seluruh aturan Salin Muatan berada di procedure; aplikasi hanya mengirim dua parameter.
        const request = this.traced(pool.request());
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        await request
          .input('CoalDeliveryNumberNya', sql.VarChar(20), coalDeliveryNumber)
          .input('nextDT', sql.VarChar(8), nextDT)
          .execute('dbo.usp_SalinMuatan');
        return { message: `Salin Muatan SK ${coalDeliveryNumber} ke ${nextDT} berhasil dijalankan melalui dbo.usp_SalinMuatan.` };
      } catch (error) {
        const number = (error as { number?: number }).number;
        if (number === 50001) throw new NotFoundException('Data final loading tidak ditemukan atau dtEmpty NULL.');
        if (number === 50002) throw new NotFoundException('Data equipment tidak ditemukan.');
        if (number === 50003) throw new ConflictException('Kosong Terima aktif yang belum dipakai tidak ditemukan.');
        if (number === 50004) throw new ConflictException('Muat Terima aktif yang belum dipakai tidak ditemukan.');
        this.logger.error('Salin Muatan failed', error);
        throw new ServiceUnavailableException('Hasil Salin Muatan belum dapat dipastikan. Muat ulang dan periksa sebelum mengulang.');
      }
    });
  }
  generateSkTerima(coalDeliveryNumber: string) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction));
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        request.input('cdn', sql.VarChar(20), coalDeliveryNumber);
        const sources = (await request.query(`SELECT TOP (1) EquipmentID, dtLoaded
          FROM dbo.tabCTFinalLoadingTonnage WITH (UPDLOCK, HOLDLOCK)
          WHERE CoalDeliveryNumber = @cdn ORDER BY dtLoaded DESC`)).recordset;
        if (!sources.length) throw new NotFoundException('Kirim sumber tidak ditemukan.');
        const source = sources[0];
        if (source.dtLoaded == null) throw new NotFoundException('Kirim sumber tidak ditemukan atau dtLoaded kosong.');
        if (source.EquipmentID == null) throw new ConflictException('Kirim sumber tidak memiliki truck.');
        request.input('equipmentId', sql.Int, source.EquipmentID).input('start', sql.DateTime, source.dtLoaded);
        const before = (await request.query(`SELECT CTFinalDumpingTonnageID
          FROM dbo.tabCTFinalDumpingTonnage WITH (UPDLOCK, HOLDLOCK) WHERE CoalDeliveryNumber = @cdn`)).recordset;
        // Kandidat mengikuti usp_DataHilang: tanpa filter dtDeletedAt dan tanpa guard relasi/insert yang sudah ada.
        const loaded = (await request.query(`SELECT TOP (1) dtTimeCollected
          FROM dbo.tabCTDumpLoaded WITH (UPDLOCK, HOLDLOCK)
          WHERE EquipmentID = @equipmentId AND dtTimeCollected >= @start
          ORDER BY dtTimeCollected ASC`)).recordset;
        if (loaded.length && loaded[0].dtTimeCollected == null) throw new ConflictException('Timbang muat sumber tidak memiliki waktu valid.');
        request.input('emptyStart', sql.DateTime, loaded[0]?.dtTimeCollected ?? source.dtLoaded);
        const empty = (await request.query(`SELECT TOP (1) dtTimeCollected
          FROM dbo.tabCTDumpEmpty WITH (UPDLOCK, HOLDLOCK)
          WHERE EquipmentID = @equipmentId AND dtTimeCollected >= @emptyStart
          ORDER BY dtTimeCollected ASC`)).recordset;
        if (!empty.length || empty[0].dtTimeCollected == null) throw new ConflictException('Timbang kosong sumber tidak ditemukan.');
        const execute = this.traced(new sql.Request(transaction));
        (execute as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        await execute.input('CoalDeliveryNumberNya', sql.VarChar(20), coalDeliveryNumber).execute('dbo.usp_DataHilang');
        const after = (await request.query(`SELECT CTFinalDumpingTonnageID, EquipmentID, dtEmpty, dtDeletedAt
          FROM dbo.tabCTFinalDumpingTonnage WHERE CoalDeliveryNumber = @cdn`)).recordset;
        const beforeIds = new Set(before.map(row => row.CTFinalDumpingTonnageID));
        const created = after.filter(row => !beforeIds.has(row.CTFinalDumpingTonnageID));
        if (created.length !== 1 || created[0].EquipmentID !== source.EquipmentID || created[0].dtDeletedAt != null || +created[0].dtEmpty !== +empty[0].dtTimeCollected) throw new ConflictException('Hasil Generate SK Terima tidak sesuai kandidat. Perubahan dibatalkan.');
        await transaction.commit();
        return { message: `Generate SK Terima untuk ${coalDeliveryNumber} berhasil; Terima #${created[0].CTFinalDumpingTonnageID}.` };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(cause => this.logger.error('Generate SK Terima rollback failed', cause));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        const number = (error as { number?: number }).number;
        if (number === 50001) throw new NotFoundException('Kirim sumber tidak ditemukan atau dtLoaded kosong.');
        if (number === 50003) throw new ConflictException('Timbang kosong sumber tidak ditemukan.');
        this.logger.error('Generate SK Terima failed', error);
        throw new ServiceUnavailableException('Hasil Generate SK Terima belum dapat dipastikan. Muat ulang dan periksa sebelum mengulang.');
      }
    });
  }
  deleteTransaction(kind: 'Kirim' | 'Terima' | 'CoalCalory', id: number) {
    const [table, column] = kind === 'Kirim'
      ? ['tabCTFinalLoadingTonnage', 'CTFinalLoadingTonnageID']
      : kind === 'Terima'
        ? ['tabCTFinalDumpingTonnage', 'CTFinalDumpingTonnageID']
        : ['tabCoalQualityAGM', 'CoalQualityAGMID'];
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction).input('id', sql.Int, id));
        const rows = (await request.query(`SELECT dtDeletedAt FROM dbo.${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${column} = @id`)).recordset;
        if (!rows.length) throw new NotFoundException(`${kind} #${id} tidak ditemukan.`);
        if (rows.length !== 1 || rows[0].dtDeletedAt != null) throw new ConflictException('Data sudah dihapus atau ID tidak unik.');
        // OUTPUT INTO tidak bergantung jumlah rowcount dari trigger dan mendukung tabel dengan trigger aktif.
        const updated = await request.query(`DECLARE @changed TABLE (id int);
          UPDATE dbo.${table} SET dtDeletedAt = GETDATE()
          OUTPUT inserted.${column} INTO @changed
          WHERE ${column} = @id AND dtDeletedAt IS NULL;
          SELECT COUNT(*) AS changed FROM @changed;`);
        if (updated.recordset?.[0]?.changed !== 1) throw new ConflictException('Penghapusan tidak mengubah tepat satu baris.');
        const check = (await request.query(`SELECT dtDeletedAt FROM dbo.${table} WHERE ${column} = @id`)).recordset;
        if (check.length !== 1 || check[0].dtDeletedAt == null) throw new ConflictException('Status penghapusan tidak terverifikasi.');
        await transaction.commit();
        return { message: `${kind} #${id} ditandai dihapus (dtDeletedAt).` };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(cause => this.logger.error('Delete transaction rollback failed', cause));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('Delete transaction failed', error);
        throw new ServiceUnavailableException('Hasil penghapusan belum dapat dipastikan. Muat ulang dan periksa sebelum mengulang.');
      }
    });
  }
  // Kebalikan deleteTransaction: dtDeletedAt kembali NULL, dtUpdatedAt diperbarui.
  restoreTransaction(kind: 'Kirim' | 'Terima', id: number) {
    const [table, column] = kind === 'Kirim'
      ? ['tabCTFinalLoadingTonnage', 'CTFinalLoadingTonnageID']
      : ['tabCTFinalDumpingTonnage', 'CTFinalDumpingTonnageID'];
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction).input('id', sql.Int, id));
        const rows = (await request.query(`SELECT dtDeletedAt FROM dbo.${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${column} = @id`)).recordset;
        if (!rows.length) throw new NotFoundException(`${kind} #${id} tidak ditemukan.`);
        if (rows.length !== 1 || rows[0].dtDeletedAt == null) throw new ConflictException('Data tidak sedang dihapus; tidak ada yang dipulihkan.');
        const updated = await request.query(`DECLARE @changed TABLE (id int);
          UPDATE dbo.${table} SET dtDeletedAt = NULL, dtUpdatedAt = GETDATE()
          OUTPUT inserted.${column} INTO @changed
          WHERE ${column} = @id AND dtDeletedAt IS NOT NULL;
          SELECT COUNT(*) AS changed FROM @changed;`);
        if (updated.recordset?.[0]?.changed !== 1) throw new ConflictException('Pemulihan tidak mengubah tepat satu baris.');
        const check = (await request.query(`SELECT dtDeletedAt FROM dbo.${table} WHERE ${column} = @id`)).recordset;
        if (check.length !== 1 || check[0].dtDeletedAt != null) throw new ConflictException('Status pemulihan tidak terverifikasi.');
        await transaction.commit();
        this.logger.log(`${kind} #${id} dipulihkan (dtDeletedAt = NULL).`);
        return { message: `${kind} #${id} dipulihkan (dtDeletedAt = NULL).` };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(cause => this.logger.error('Restore transaction rollback failed', cause));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('Restore transaction failed', error);
        throw new ServiceUnavailableException('Hasil pemulihan belum dapat dipastikan. Muat ulang dan periksa sebelum mengulang.');
      }
    });
  }
  // Satu pintu anomali: seluruh kode temuan didefinisikan di dbo.usp_MonitoringAnomali.
  // Menambah anomali baru cukup menambah blok UNION ALL di procedure, bukan di TypeScript.
  anomalies(start: Date, end: Date, filters: { code?: string; truck?: string; cdn?: string; severity?: string; category?: string }) {
    return this.withQueries(async () => ({
      anomalies: await this.read(async request => {
        (request as sql.Request & { overrides: { requestTimeout?: number } }).overrides.requestTimeout = 60000;
        const result = await request
          .input('Mulai', sql.DateTime, start)
          .input('Selesai', sql.DateTime, end)
          .input('Kode', sql.VarChar(50), filters.code ?? null)
          .input('Truck', sql.VarChar(50), filters.truck ?? null)
          .input('Cdn', sql.VarChar(50), filters.cdn ?? null)
          .input('Severity', sql.VarChar(10), filters.severity ?? null)
          .input('Kategori', sql.VarChar(20), filters.category ?? null)
          .execute('dbo.usp_MonitoringAnomali');
        return result.recordset as Array<Record<string, unknown>>;
      })
    }));
  }
  // Daftar Coal Calory aktif; baris dengan dtDeletedAt terisi disembunyikan.
  coalCalories() {
    return this.query<CoalCalory>(`SELECT CoalQualityAGMID, CoalQualityID, CoalQualityName, Coalcalory, dtUpdatedAt
      FROM dbo.tabCoalQualityAGM WHERE dtDeletedAt IS NULL ORDER BY CoalQualityName, CoalQualityAGMID`);
  }
  // Trigger trg_Sync_CoalQualityAGM_To_Enum_Update menyalin nama dan tanggal ke tabEnum.
  updateCoalCalory(id: number, coalQualityName: string, coalcalory: number | null) {
    return this.withQueries(async () => {
      let transaction: sql.Transaction | undefined;
      let rolledBack = false;
      try {
        transaction = new sql.Transaction(await this.connect());
        transaction.on('rollback', () => { rolledBack = true; });
        await transaction.begin();
        const request = this.traced(new sql.Request(transaction)
          .input('id', sql.Int, id)
          .input('CoalQualityName', sql.VarChar(255), coalQualityName)
          .input('Coalcalory', sql.Int, coalcalory));
        const rows = (await request.query(`SELECT dtDeletedAt FROM dbo.tabCoalQualityAGM WITH (UPDLOCK, HOLDLOCK)
          WHERE CoalQualityAGMID = @id`)).recordset;
        if (!rows.length) throw new NotFoundException(`Coal Calory #${id} tidak ditemukan.`);
        if (rows.length !== 1 || rows[0].dtDeletedAt != null) throw new ConflictException('Data sudah dihapus atau ID tidak unik.');
        // OUTPUT INTO tidak bergantung jumlah rowcount dari trigger sync ke tabEnum.
        const updated = await request.query(`DECLARE @changed TABLE (id int);
          UPDATE dbo.tabCoalQualityAGM SET CoalQualityName = @CoalQualityName, Coalcalory = @Coalcalory, dtUpdatedAt = GETDATE()
          OUTPUT inserted.CoalQualityAGMID INTO @changed
          WHERE CoalQualityAGMID = @id AND dtDeletedAt IS NULL;
          SELECT COUNT(*) AS changed FROM @changed;`);
        if (updated.recordset?.[0]?.changed !== 1) throw new ConflictException('Perubahan tidak mengubah tepat satu baris.');
        await transaction.commit();
        const message = `Coal Calory #${id} diperbarui (${coalQualityName}${coalcalory === null ? ', kalori kosong' : `, ${coalcalory}`}).`;
        this.logger.log(message);
        return { message };
      } catch (error) {
        if (transaction && !rolledBack) await transaction.rollback().catch(cause => this.logger.error('Coal Calory rollback failed', cause));
        if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
        this.logger.error('Coal Calory update failed', error);
        throw new ServiceUnavailableException('Perubahan Coal Calory gagal atau hasilnya belum dapat dipastikan. Muat ulang dan periksa sebelum mencoba lagi.');
      }
    });
  }
  equipments(activeOnly = false) {
    return this.query<Equipment>(`SELECT EquipmentID, strTruckCN FROM tabEquipment${activeOnly ? ' WHERE dtDeletedAt IS NULL' : ''} ORDER BY strTruckCN`);
  }
  equipment(id: number) {
    return this.query<Equipment>('SELECT EquipmentID, strTruckCN FROM tabEquipment WHERE EquipmentID = @id', id);
  }
  locations() {
    return this.query<Location>('SELECT LocationID, strLocationName FROM tabLocation WHERE locationTypeID = 7 AND dtDeletedAt IS NULL ORDER BY strLocationName');
  }
  async onModuleDestroy() {
    await this.pool?.close();
  }
}
