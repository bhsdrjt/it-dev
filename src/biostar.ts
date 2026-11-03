import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sql from 'mssql';

// Ponytail: parser ZIP ini membaca seluruh arsip ke memori dengan batas ukuran.
// Tingkatkan ke streaming parser (node:zlib + central directory scan) saat paket besar menjadi risiko memori.
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB batas upload terkompresi.
const REQUIRED_FILES = ['users.csv', 'fingerprints.csv', 'cards.csv', 'user_cards.csv'] as const;
type RequiredFile = (typeof REQUIRED_FILES)[number];

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  dataOffset: number;
}

function readUInt32LE(buffer: Buffer, offset: number): number { return buffer.readUInt32LE(offset); }
function readUInt16LE(buffer: Buffer, offset: number): number { return buffer.readUInt16LE(offset); }

function parseZip(buffer: Buffer): ZipEntry[] {
  if (!buffer || buffer.length === 0) throw new BadRequestException('Berkas ZIP kosong atau tidak terbaca.');
  if (buffer.length > MAX_ZIP_BYTES) throw new BadRequestException('ZIP melebihi batas upload terkompresi.');
  // Tanda ZIP lokal harus diawali PK\x03\x04.
  if (buffer.length < 4 || readUInt32LE(buffer, 0) !== ZIP_LOCAL) {
    const head = buffer.subarray(0, Math.min(8, buffer.length)).toString('hex');
    throw new BadRequestException(`Berkas bukan ZIP yang valid (panjang ${buffer.length} byte, header ${head}).`);
  }
  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 65536 - 22);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (readUInt32LE(buffer, i) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new BadRequestException('Arsip ZIP rusak: end of central directory tidak ditemukan.');
  const cdOffset = readUInt32LE(buffer, eocd + 16);
  const cdSize = readUInt32LE(buffer, eocd + 12);
  const cdCount = readUInt16LE(buffer, eocd + 10);
  if (cdOffset + cdSize > buffer.length) throw new BadRequestException('Arsip ZIP rusak: central directory melebihi batas berkas.');
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const off = cursor;
    if (off + 46 > buffer.length) throw new BadRequestException('Arsip ZIP rusak: entri central directory tidak lengkap.');
    if (readUInt32LE(buffer, off) !== ZIP_CENTRAL) throw new BadRequestException('Arsip ZIP rusak: tanda central directory tidak valid.');
    const flag = readUInt16LE(buffer, off + 8);
    const method = readUInt16LE(buffer, off + 10);
    const crc32 = readUInt32LE(buffer, off + 16);
    const compressedSize = readUInt32LE(buffer, off + 20);
    const uncompressedSize = readUInt32LE(buffer, off + 24);
    const fnameLen = readUInt16LE(buffer, off + 28);
    const extraLen = readUInt16LE(buffer, off + 30);
    const commentLen = readUInt16LE(buffer, off + 32);
    const localHeaderOffset = readUInt32LE(buffer, off + 42);
    if (flag & 0x01) throw new BadRequestException('ZIP terenkripsi tidak didukung.');
    if (flag & 0x08) throw new BadRequestException('ZIP dengan data descriptor tidak didukung.');
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF) throw new BadRequestException('ZIP64 tidak didukung.');
    if (commentLen !== 0) throw new BadRequestException('Komentar entri ZIP tidak didukung.');
    const nameStart = off + 46;
    const nameEnd = nameStart + fnameLen;
    if (nameEnd > buffer.length) throw new BadRequestException('Arsip ZIP rusak: nama entri melebihi batas.');
    const name = buffer.toString('utf8', nameStart, nameEnd);
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.startsWith('.')) {
      throw new BadRequestException(`Nama entri tidak aman: ${name}.`);
    }
    if (seen.has(name)) throw new BadRequestException(`Entri duplikat dalam ZIP: ${name}.`);
    seen.add(name);
    if (localHeaderOffset + 30 > buffer.length) throw new BadRequestException('Arsip ZIP rusak: offset header lokal di luar batas.');
    if (readUInt32LE(buffer, localHeaderOffset) !== ZIP_LOCAL) throw new BadRequestException('Arsip ZIP rusak: tanda header lokal tidak valid.');
    const lfnameLen = readUInt16LE(buffer, localHeaderOffset + 26);
    const lextraLen = readUInt16LE(buffer, localHeaderOffset + 28);
    if (lfnameLen !== fnameLen) throw new BadRequestException(`Panjang nama entri tidak cocok: ${name}.`);
    const dataOffset = localHeaderOffset + 30 + lfnameLen + lextraLen;
    if (dataOffset + compressedSize > buffer.length) throw new BadRequestException(`Data entri melebihi batas berkas: ${name}.`);
    entries.push({ name, method, compressedSize, uncompressedSize, crc32, dataOffset });
    cursor = nameEnd + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const data = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === METHOD_STORED) return data;
  if (entry.method === METHOD_DEFLATE) {
    try { return require('node:zlib').inflateRawSync(data); } catch { throw new BadRequestException(`Gagal dekompresi entri: ${entry.name}.`); }
  }
  throw new BadRequestException(`Metode kompresi tidak didukung untuk ${entry.name}.`);
}

// ---------- CSV parser (RFC4180, tanpa Split(',') mentah) ----------

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let header: string[] | null = null;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '\"') {
        if (i + 1 < n && text[i + 1] === '\"') { field += '\"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '\"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') {
      if (i + 1 < n && text[i + 1] === '\n') i++;
      pushField(); pushRow(); i++; continue;
    }
    if (ch === '\n') { pushField(); pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field || row.length) { pushField(); pushRow(); }
  if (rows.length === 0) throw new BadRequestException('CSV kosong atau tidak memiliki header.');
  header = rows[0];
  rows.shift();
  // Tolak header duplikat.
  const dupes = header.filter((v, i) => header.indexOf(v) !== i);
  if (dupes.length) throw new BadRequestException(`CSV: header duplikat ${JSON.stringify(dupes)}.`);
  return { header, rows };
}

function colIndex(header: string[], name: string, file: string): number {
  const idx = header.indexOf(name);
  if (idx === -1) throw new BadRequestException(`${file}: kolom '${name}' tidak ditemukan pada header (${JSON.stringify(header)}).`);
  return idx;
}

function bigintOrNull(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (!/^[+-]?\d+$/.test(text)) throw new BadRequestException('IDXUSRID/IDXUSRIDNUM harus bilangan bulat atau kosong.');
  const number = BigInt(text);
  if (number < -9223372036854775808n || number > 9223372036854775807n) {
    throw new BadRequestException('IDXUSRID/IDXUSRIDNUM melebihi rentang SQL bigint.');
  }
  return number.toString();
}

function getCell(row: string[], index: number, file: string, rowNo: number): string | null {
  const value = row[index];
  if (value === undefined) throw new BadRequestException(`${file} baris ${rowNo}: kolom ke-${index + 1} hilang.`);
  if (value === '\\N') return null;
  return decodeBackslash(value, file, rowNo);
}

function decodeBackslash(value: string, file: string, rowNo: number): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      const next = value[i + 1];
      if (next === '\\') { result += '\\'; i++; continue; }
      throw new BadRequestException(`${file} baris ${rowNo}: escape backslash tidak valid '${ch}${next ?? ''}'.`);
    }
    result += ch;
  }
  return result;
}

// ---------- Manifest ----------

interface ManifestFile {
  name: string;
  size: number;
  records: number;
  sha256: string;
}

interface Manifest {
  format_version: string;
  schema_contract_id: string;
  package_id: string;
  exported_at_utc: string;
  exporter_version: string;
  source: string;
  selection_summary: unknown;
  dependencies: unknown;
  files: ManifestFile[];
  totals: unknown;
}

function parseManifest(text: string): Manifest {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new BadRequestException('manifest.json bukan JSON valid.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BadRequestException('manifest.json harus objek JSON.');
  const m = data as Record<string, unknown>;
  const required = ['format_version', 'schema_contract_id', 'package_id', 'exported_at_utc', 'exporter_version', 'files', 'totals'];
  for (const key of required) {
    if (!(key in m)) throw new BadRequestException(`manifest.json: field wajib '${key}' hilang.`);
  }
  // source / selection_summary / dependencies boleh berada di export_context (format exporter asli).
  const exportContext = m.export_context && typeof m.export_context === 'object' && !Array.isArray(m.export_context)
    ? (m.export_context as Record<string, unknown>)
    : {};
  if (!('source' in m)) m.source = exportContext.source ?? null;
  if (!('selection_summary' in m)) m.selection_summary = exportContext.selection_summary ?? null;
  if (!('dependencies' in m)) m.dependencies = exportContext.dependencies ?? null;
  for (const key of ['source', 'selection_summary', 'dependencies']) {
    if (!(key in m)) throw new BadRequestException(`manifest.json: field wajib '${key}' hilang.`);
  }
  if (!Array.isArray(m.files) || m.files.length !== 4) throw new BadRequestException('manifest.json: files harus tepat 4 entri CSV.');
  for (const f of m.files as unknown[]) {
    if (!f || typeof f !== 'object') throw new BadRequestException('manifest.json: entri files harus objek.');
    const ff = f as Record<string, unknown>;
    for (const key of ['name', 'sha256']) {
      if (!(key in ff)) throw new BadRequestException(`manifest.json: entri files missing '${key}'.`);
    }
    if (typeof ff.name !== 'string' || !REQUIRED_FILES.includes(ff.name as RequiredFile)) {
      throw new BadRequestException(`manifest.json: nama file '${String(ff.name)}' tidak diizinkan.`);
    }
    // Terima size/size_bytes dan records/record_count (format exporter bervariasi).
    const size = ff.size ?? ff.size_bytes;
    const records = ff.records ?? ff.record_count;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) throw new BadRequestException('manifest.json: size harus angka.');
    if (typeof records !== 'number' || !Number.isFinite(records) || records < 0) throw new BadRequestException('manifest.json: records harus angka.');
    if (typeof ff.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ff.sha256)) throw new BadRequestException('manifest.json: sha256 harus heksadesimal 64 karakter.');
    (ff as Record<string, unknown>).size = size;
    (ff as Record<string, unknown>).records = records;
  }
  const names = (m.files as ManifestFile[]).map(f => f.name);
  for (const requiredName of REQUIRED_FILES) {
    if (!names.includes(requiredName)) throw new BadRequestException(`manifest.json: file wajib '${requiredName}' tidak tercantum.`);
  }
  return m as unknown as Manifest;
}

// ---------- Suffix allocator (PRD §9) ----------

// Nomor pengganti: minimal 4 digit, disatukan langsung dengan ID sumber (tanpa strip, tanpa nol di depan pada angka pengganti).
// Contoh keputusan tim: 3 -> 30001, 30001 -> 30002. ID sumber yang sudah ada angka tetap teks utuh.
function padMin4(n: number): string { return String(n).padStart(4, '0'); }

export function planUserIds(sources: string[], existing: Set<string>): Map<string, string> {
  const reserved = new Set(existing);
  const plan = new Map<string, string>();
  for (const source of sources) {
    if (!reserved.has(source)) { plan.set(source, source); reserved.add(source); }
  }
  for (const source of sources) {
    if (plan.has(source)) continue;
    let n = 1;
    let candidate = `${source}${padMin4(n)}`;
    while (reserved.has(candidate)) { n++; candidate = `${source}${padMin4(n)}`; }
    plan.set(source, candidate);
    reserved.add(candidate);
  }
  return plan;
}

// ---------- Parsed package ----------

export type ImportUser = {
  sourceUsrUid: string;
  sourceUsrId: string;
  targetUsrId: string;
  status: 'Tetap' | 'Diganti' | 'Diblokir';
  fingerprintCount: number;
  csnCount: number;
  // Profil T_USR (diisi dari CSV bila tersisa, null jika tidak ada -> default DB).
  nm: string | null;
  department: string | null;
  title: string | null;
  pwSta: number | null;
  del: string | null;
  isUsrGr: string | null;
  lgnId: string | null;
  pin: string | null;
  usrGrUid: number | null;
  permUid: number | null;
  lstMod: number | null;
  createDt: Date | null;
  idxUsrId: string | null;
  idxUsrIdNum: string | null;
  userIp: string | null;
};

export type ImportFingerprint = {
  sourceUsrUid: string;
  fngpIdx: number | null;
  dur: string | null;
  tml0: Buffer | null;
  tml1: Buffer | null;
  chs: string | null;
  lstmod: string | null;
};

export type ImportCard = {
  sourceCrdUid: string;
  crdTypUid: number | null;
  crdCsn: string;
  asmUid: number | null;
  wgdfmUid: number | null;
  wgdfmTver: number | null;
};

export type ImportRelation = {
  sourceUsrUid: string;
  sourceCrdUid: string;
  idx: number | null;
  issddt: Date | null;
  expdt: Date | null;
  issdcnt: number | null;
  crdmsk: number | null;
  prdstdt: Date | null;
  prdeddt: Date | null;
};

export type ParsedPackage = {
  users: ImportUser[];
  fingerprints: ImportFingerprint[];
  cards: ImportCard[];
  relations: ImportRelation[];
  summary: ImportSummary;
  preview: ImportPreview;
};

export type JobStatus =
  | 'UPLOADED' | 'VALIDATING' | 'REJECTED' | 'READY' | 'QUEUED' | 'IMPORTING'
  | 'PREVIEW_STALE' | 'CANCELLING' | 'CANCELLED' | 'FAILED' | 'COMMITTED' | 'RECONCILIATION_REQUIRED';

export type ImportJob = {
  id: string;
  packageId: string;
  target: string;
  status: JobStatus;
  revision: number;
  summary: ImportSummary | null;
  preview: ImportPreview | null;
  confirmError: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelled: boolean;
  parsed?: ParsedPackage;
};

export type ImportSummary = {
  packageId: string;
  formatVersion: string;
  exporterVersion: string;
  exportedAtUtc: string;
  source: string;
  userCount: number;
  fingerprintCount: number;
  cardCount: number;
  relationCount: number;
  usersWithoutCredential: number;
};

export type PreviewUser = {
  sourceUsrUid: string;
  sourceUsrId: string;
  name: string | null;
  targetUsrId: string;
  status: 'Tetap' | 'Diganti' | 'Diblokir';
  reason: string | null;
  fingerprintCount: number;
  csnCount: number;
};

export type ImportPreview = {
  revision: number;
  users: PreviewUser[];
  changedCount: number;
  unchangedCount: number;
  credentialCount: { fingerprint: number; card: number; relation: number };
};

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

function toNumberOrNull(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toDateOrNull(value: string | null): Date | null {
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

// ---------- Service ----------

@Injectable()
export class BiostarService {
  private jobs = new Map<string, ImportJob>();
  private readonly lockedTargets = new Set<string>();
  private readonly logger = new Logger(BiostarService.name);
  private biostarPool?: sql.ConnectionPool;
  private biostarConnecting?: Promise<sql.ConnectionPool>;

  private async biostarConnect(): Promise<sql.ConnectionPool> {
    if (this.biostarPool?.connected) return this.biostarPool;
    if (this.biostarConnecting) return this.biostarConnecting;
    if (!process.env.BIOSTAR_DB_SERVER || !process.env.BIOSTAR_DB_DATABASE || !process.env.BIOSTAR_DB_USER || !process.env.BIOSTAR_DB_PASSWORD) {
      throw new ServiceUnavailableException('Konfigurasi target BioStar (BIOSTAR_DB_*) belum diisi di .env.');
    }
    const pool = new sql.ConnectionPool({
      server: process.env.BIOSTAR_DB_SERVER!, database: process.env.BIOSTAR_DB_DATABASE!,
      user: process.env.BIOSTAR_DB_USER!, password: process.env.BIOSTAR_DB_PASSWORD!,
      port: Number(process.env.BIOSTAR_DB_PORT || 1433), connectionTimeout: 5000, requestTimeout: 30000,
      pool: { min: 0, max: 5, idleTimeoutMillis: 30000 },
      options: { encrypt: process.env.BIOSTAR_DB_ENCRYPT !== 'false', trustServerCertificate: process.env.BIOSTAR_DB_TRUST_SERVER_CERTIFICATE === 'true' },
    });
    pool.on('error', error => {
      this.logger.error('SQL BioStar pool error', error);
      if (this.biostarPool === pool) this.biostarPool = undefined;
      void pool.close().catch(() => undefined);
    });
    this.biostarConnecting = pool.connect().then(connected => { this.biostarPool = connected; return connected; }).catch(async error => {
      await pool.close().catch(() => undefined);
      throw error;
    }).finally(() => { this.biostarConnecting = undefined; });
    return this.biostarConnecting;
  }

  async checkConnection(): Promise<sql.ConnectionPool> {
    return this.biostarConnect();
  }
  async onModuleDestroy() {
    await this.biostarConnecting?.catch(() => undefined);
    await this.biostarPool?.close();
  }

  listJobs(): ImportJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  getJob(id: string): ImportJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`Pekerjaan impor ${id} tidak ditemukan.`);
    return job;
  }

  createJob(packageId: string, target: string): ImportJob {
    const id = `${packageId}-${Date.now()}`;
    const job: ImportJob = {
      id, packageId, target, status: 'UPLOADED', revision: 0, summary: null, preview: null,
      confirmError: null, createdAt: new Date(), updatedAt: new Date(), cancelled: false,
    };
    this.jobs.set(id, job);
    return job;
  }

  private setStatus(job: ImportJob, status: JobStatus): void {
    job.status = status;
    job.updatedAt = new Date();
  }

  async parsePackage(jobId: string, zipBuffer: Buffer): Promise<ImportJob> {
    const job = this.getJob(jobId);
    if (job.status !== 'UPLOADED') throw new BadRequestException('Paket sudah diproses atau tidak dapat divalidasi ulang.');
    this.setStatus(job, 'VALIDATING');
    try {
      const entries = parseZip(zipBuffer);
      const byName = new Map(entries.map(e => [e.name, e]));
      for (const name of REQUIRED_FILES) {
        if (!byName.has(name)) throw new BadRequestException(`ZIP tidak berisi file wajib '${name}'.`);
      }

      const manifestText = extractEntry(zipBuffer, byName.get('manifest.json')!);
      const manifest = parseManifest(manifestText.toString('utf8'));

      // Verifikasi SHA-256 setiap CSV sebelum parsing.
      const files = new Map<string, Buffer>();
      for (const mf of manifest.files) {
        const entry = byName.get(mf.name);
        if (!entry) throw new BadRequestException(`File '${mf.name}' tercantum manifest tetapi tidak ada dalam ZIP.`);
        const data = extractEntry(zipBuffer, entry);
        if (data.length !== mf.size) throw new BadRequestException(`Ukuran '${mf.name}' tidak cocok manifest.`);
        if (sha256(data) !== mf.sha256) throw new BadRequestException(`SHA-256 '${mf.name}' tidak cocok manifest.`);
        files.set(mf.name, data);
      }

      const usersCsv = parseCsv(files.get('users.csv')!.toString('utf8'));
      const fpCsv = parseCsv(files.get('fingerprints.csv')!.toString('utf8'));
      const cardsCsv = parseCsv(files.get('cards.csv')!.toString('utf8'));
      const relCsv = parseCsv(files.get('user_cards.csv')!.toString('utf8'));

      // users.csv
      const users: ImportUser[] = [];
      const seenUid = new Set<string>();
      const seenUsrId = new Set<string>();
      const uSourceIdx = colIndex(usersCsv.header, 'source_usr_uid', 'users.csv');
      const uIdIdx = colIndex(usersCsv.header, 'USRID', 'users.csv');
      const uNmIdx = usersCsv.header.includes('NM') ? colIndex(usersCsv.header, 'NM', 'users.csv') : -1;
      const uDeptIdx = usersCsv.header.includes('DEPARTMENT') ? colIndex(usersCsv.header, 'DEPARTMENT', 'users.csv') : -1;
      const uTitleIdx = usersCsv.header.includes('TITLE') ? colIndex(usersCsv.header, 'TITLE', 'users.csv') : -1;
      const uPwStaIdx = usersCsv.header.includes('PWSTA') ? colIndex(usersCsv.header, 'PWSTA', 'users.csv') : -1;
      const uDelIdx = usersCsv.header.includes('DEL') ? colIndex(usersCsv.header, 'DEL', 'users.csv') : -1;
      const uIsUsrGrIdx = usersCsv.header.includes('ISUSRGR') ? colIndex(usersCsv.header, 'ISUSRGR', 'users.csv') : -1;
      const uLgnIdIdx = usersCsv.header.includes('LGNID') ? colIndex(usersCsv.header, 'LGNID', 'users.csv') : -1;
      const uPinIdx = usersCsv.header.includes('PIN') ? colIndex(usersCsv.header, 'PIN', 'users.csv') : -1;
      const uUsrGrUidIdx = usersCsv.header.includes('USRGRUID') ? colIndex(usersCsv.header, 'USRGRUID', 'users.csv') : -1;
      const uPermUidIdx = usersCsv.header.includes('PERMUID') ? colIndex(usersCsv.header, 'PERMUID', 'users.csv') : -1;
      const uLstModIdx = usersCsv.header.includes('LSTMOD') ? colIndex(usersCsv.header, 'LSTMOD', 'users.csv') : -1;
      const uCreateDtIdx = usersCsv.header.includes('CREATEDT') ? colIndex(usersCsv.header, 'CREATEDT', 'users.csv') : -1;
      const uIdxUsrIdIdx = usersCsv.header.indexOf('IDXUSRID');
      const uIdxUsrIdNumIdx = usersCsv.header.indexOf('IDXUSRIDNUM');
      const uUserIpIdx = usersCsv.header.includes('USERIP') ? colIndex(usersCsv.header, 'USERIP', 'users.csv') : -1;

      for (let r = 0; r < usersCsv.rows.length; r++) {
        const row = usersCsv.rows[r];
        const sourceUsrUid = getCell(row, uSourceIdx, 'users.csv', r + 2);
        const sourceUsrId = getCell(row, uIdIdx, 'users.csv', r + 2);
        if (sourceUsrUid === null || sourceUsrId === null) throw new BadRequestException('users.csv: source_usr_uid/USRID wajib diisi.');
        if (seenUid.has(sourceUsrUid)) throw new BadRequestException(`users.csv: source_usr_uid duplikat '${sourceUsrUid}'.`);
        if (seenUsrId.has(sourceUsrId)) throw new BadRequestException(`users.csv: USRID duplikat dalam paket '${sourceUsrId}'.`);
        seenUid.add(sourceUsrUid);
        seenUsrId.add(sourceUsrId);
        const cell = (idx: number) => idx === -1 ? null : getCell(row, idx, 'users.csv', r + 2);
        users.push({
          sourceUsrUid, sourceUsrId, targetUsrId: '', status: 'Tetap', fingerprintCount: 0, csnCount: 0,
          nm: cell(uNmIdx), department: cell(uDeptIdx), title: cell(uTitleIdx),
          pwSta: toNumberOrNull(cell(uPwStaIdx)), del: cell(uDelIdx), isUsrGr: cell(uIsUsrGrIdx),
          lgnId: cell(uLgnIdIdx), pin: cell(uPinIdx),
          usrGrUid: toNumberOrNull(cell(uUsrGrUidIdx)), permUid: toNumberOrNull(cell(uPermUidIdx)),
          lstMod: toNumberOrNull(cell(uLstModIdx)), createDt: toDateOrNull(cell(uCreateDtIdx)),
          idxUsrId: bigintOrNull(cell(uIdxUsrIdIdx)), idxUsrIdNum: bigintOrNull(cell(uIdxUsrIdNumIdx)),
          userIp: cell(uUserIpIdx),
        });
      }

      // fingerprints.csv
      const fingerprints: ImportFingerprint[] = [];
      const fSourceIdx = colIndex(fpCsv.header, 'source_usr_uid', 'fingerprints.csv');
      const fIdxIdx = colIndex(fpCsv.header, 'FNGPIDX', 'fingerprints.csv');
      const fDurIdx = colIndex(fpCsv.header, 'DUR', 'fingerprints.csv');
      const fTml0Idx = colIndex(fpCsv.header, 'TMPL0', 'fingerprints.csv');
      const fTml1Idx = colIndex(fpCsv.header, 'TMPL1', 'fingerprints.csv');
      const fChsIdx = colIndex(fpCsv.header, 'CHS', 'fingerprints.csv');
      const fLstIdx = colIndex(fpCsv.header, 'LSTMOD', 'fingerprints.csv');
      const seenFp = new Set<string>();
      for (let r = 0; r < fpCsv.rows.length; r++) {
        const row = fpCsv.rows[r];
        const sourceUsrUid = getCell(row, fSourceIdx, 'fingerprints.csv', r + 2);
        if (sourceUsrUid === null) throw new BadRequestException('fingerprints.csv: source_usr_uid wajib diisi.');
        const fngpIdxRaw = getCell(row, fIdxIdx, 'fingerprints.csv', r + 2);
        const fngpIdx = fngpIdxRaw === null ? null : Number(fngpIdxRaw);
        if (fngpIdx !== null && ![0,1,2,3,4,5,6,7,8,9,10,255].includes(fngpIdx)) {
          throw new BadRequestException(`fingerprints.csv baris ${r + 2}: FNGPIDX ${fngpIdx} tidak sesuai kontrak (0-10 atau 255).`);
        }
        const fpKey = `${sourceUsrUid}|${fngpIdx}`;
        if (seenFp.has(fpKey)) throw new BadRequestException(`fingerprints.csv: duplikasi ${fpKey}.`);
        seenFp.add(fpKey);
        const t0Raw = getCell(row, fTml0Idx, 'fingerprints.csv', r + 2);
        const t1Raw = getCell(row, fTml1Idx, 'fingerprints.csv', r + 2);
        fingerprints.push({
          sourceUsrUid, fngpIdx,
          dur: getCell(row, fDurIdx, 'fingerprints.csv', r + 2),
          tml0: t0Raw === null ? null : Buffer.from(t0Raw, 'base64'),
          tml1: t1Raw === null ? null : Buffer.from(t1Raw, 'base64'),
          chs: getCell(row, fChsIdx, 'fingerprints.csv', r + 2),
          lstmod: getCell(row, fLstIdx, 'fingerprints.csv', r + 2),
        });
      }

      // cards.csv
      const cards: ImportCard[] = [];
      const cSourceIdx = colIndex(cardsCsv.header, 'source_crd_uid', 'cards.csv');
      const cTypIdx = colIndex(cardsCsv.header, 'CRDTYPUID', 'cards.csv');
      const cCsnIdx = colIndex(cardsCsv.header, 'CRDCSN', 'cards.csv');
      const cAsmIdx = colIndex(cardsCsv.header, 'ASMUID', 'cards.csv');
      const cWgfIdx = colIndex(cardsCsv.header, 'WGDFMUID', 'cards.csv');
      const cWgfvIdx = colIndex(cardsCsv.header, 'WGDFMTVER', 'cards.csv');
      const seenCrd = new Set<string>();
      for (let r = 0; r < cardsCsv.rows.length; r++) {
        const row = cardsCsv.rows[r];
        const sourceCrdUid = getCell(row, cSourceIdx, 'cards.csv', r + 2);
        if (sourceCrdUid === null) throw new BadRequestException('cards.csv: source_crd_uid wajib diisi.');
        if (seenCrd.has(sourceCrdUid)) throw new BadRequestException(`cards.csv: source_crd_uid duplikat '${sourceCrdUid}'.`);
        seenCrd.add(sourceCrdUid);
        const crdCsn = getCell(row, cCsnIdx, 'cards.csv', r + 2);
        if (crdCsn === null || !crdCsn.trim()) throw new BadRequestException('cards.csv: CRDCSN wajib diisi dan tidak boleh whitespace.');
        cards.push({
          sourceCrdUid,
          crdTypUid: toNumberOrNull(getCell(row, cTypIdx, 'cards.csv', r + 2)),
          crdCsn: crdCsn!,
          asmUid: toNumberOrNull(getCell(row, cAsmIdx, 'cards.csv', r + 2)),
          wgdfmUid: toNumberOrNull(getCell(row, cWgfIdx, 'cards.csv', r + 2)),
          wgdfmTver: toNumberOrNull(getCell(row, cWgfvIdx, 'cards.csv', r + 2)),
        });
      }

      // user_cards.csv
      const relations: ImportRelation[] = [];
      const rUsrIdx = colIndex(relCsv.header, 'source_usr_uid', 'user_cards.csv');
      const rCrdIdx = colIndex(relCsv.header, 'source_crd_uid', 'user_cards.csv');
      const rIdxIdx = colIndex(relCsv.header, 'IDX', 'user_cards.csv');
      const rIssIdx = colIndex(relCsv.header, 'ISSDDT', 'user_cards.csv');
      const rExpIdx = colIndex(relCsv.header, 'EXPDT', 'user_cards.csv');
      const rCntIdx = colIndex(relCsv.header, 'ISSDCNT', 'user_cards.csv');
      const rMskIdx = colIndex(relCsv.header, 'CRDMSK', 'user_cards.csv');
      const rPsdIdx = colIndex(relCsv.header, 'PRDSTDT', 'user_cards.csv');
      const rPedIdx = colIndex(relCsv.header, 'PRDEDDT', 'user_cards.csv');
      for (let r = 0; r < relCsv.rows.length; r++) {
        const row = relCsv.rows[r];
        relations.push({
          sourceUsrUid: getCell(row, rUsrIdx, 'user_cards.csv', r + 2)!,
          sourceCrdUid: getCell(row, rCrdIdx, 'user_cards.csv', r + 2)!,
          idx: toNumberOrNull(getCell(row, rIdxIdx, 'user_cards.csv', r + 2)),
          issddt: toDateOrNull(getCell(row, rIssIdx, 'user_cards.csv', r + 2)),
          expdt: toDateOrNull(getCell(row, rExpIdx, 'user_cards.csv', r + 2)),
          issdcnt: toNumberOrNull(getCell(row, rCntIdx, 'user_cards.csv', r + 2)),
          crdmsk: toNumberOrNull(getCell(row, rMskIdx, 'user_cards.csv', r + 2)),
          prdstdt: toDateOrNull(getCell(row, rPsdIdx, 'user_cards.csv', r + 2)),
          prdeddt: toDateOrNull(getCell(row, rPedIdx, 'user_cards.csv', r + 2)),
        });
      }

      const pool = await this.biostarConnect();
      const { usrIds } = await this.fetchExistingIds(pool);
      const plan = planUserIds(users.map(u => u.sourceUsrId), usrIds);
      const previewUsers: PreviewUser[] = users.map(u => {
        const target = plan.get(u.sourceUsrId)!;
        return {
          sourceUsrUid: u.sourceUsrUid,
          sourceUsrId: u.sourceUsrId,
          name: u.nm,
          targetUsrId: target,
          status: target === u.sourceUsrId ? 'Tetap' : 'Diganti',
          reason: target === u.sourceUsrId ? null : 'Konflik USRID di target',
          fingerprintCount: fingerprints.filter(f => f.sourceUsrUid === u.sourceUsrUid).length,
          csnCount: relations.filter(rel => rel.sourceUsrUid === u.sourceUsrUid).length,
        };
      });
      const changed = previewUsers.filter(u => u.status === 'Diganti').length;
      const fpByUser = new Map<string, number>();
      for (const f of fingerprints) fpByUser.set(f.sourceUsrUid, (fpByUser.get(f.sourceUsrUid) ?? 0) + 1);
      const csnByUser = new Map<string, number>();
      for (const rel of relations) csnByUser.set(rel.sourceUsrUid, (csnByUser.get(rel.sourceUsrUid) ?? 0) + 1);
      for (const u of previewUsers) {
        u.fingerprintCount = fpByUser.get(u.sourceUsrUid) ?? 0;
        u.csnCount = csnByUser.get(u.sourceUsrUid) ?? 0;
      }

      const parsed: ParsedPackage = {
        users: users.map((u, i) => ({ ...u, targetUsrId: previewUsers[i].targetUsrId, status: previewUsers[i].status })),
        fingerprints,
        cards,
        relations,
        summary: {
          packageId: manifest.package_id,
          formatVersion: manifest.format_version,
          exporterVersion: manifest.exporter_version,
          exportedAtUtc: manifest.exported_at_utc,
          source: manifest.source,
          userCount: users.length,
          fingerprintCount: fingerprints.length,
          cardCount: cards.length,
          relationCount: relations.length,
          usersWithoutCredential: users.filter(u => !fpByUser.has(u.sourceUsrUid) && !csnByUser.has(u.sourceUsrUid)).length,
        },
        preview: {
          revision: 1,
          users: previewUsers,
          changedCount: changed,
          unchangedCount: users.length - changed,
          credentialCount: { fingerprint: fingerprints.length, card: cards.length, relation: relations.length },
        },
      };

      job.parsed = parsed;
      job.summary = parsed.summary;
      job.preview = parsed.preview;
      this.setStatus(job, 'READY');
      return job;
    } catch (error) {
      this.setStatus(job, 'REJECTED');
      throw error;
    }
  }

  async preview(jobId: string): Promise<ImportPreview> {
    const job = this.getJob(jobId);
    if (!job.preview) throw new BadRequestException('Preview belum tersedia. Validasi paket terlebih dahulu.');
    return job.preview;
  }

  async confirm(jobId: string, revision: number): Promise<ImportJob> {
    const job = this.getJob(jobId);
    if (!job.preview || job.preview.revision !== revision) throw new BadRequestException('Revisi preview tidak cocok. Buat preview ulang.');
    this.lockedTargets.add(job.target);
    job.revision = revision;
    job.confirmError = null;
    this.setStatus(job, 'QUEUED');
    return job;
  }

  async cancel(jobId: string): Promise<ImportJob> {
    const job = this.getJob(jobId);
    if (job.status === 'COMMITTED' || job.status === 'CANCELLED') throw new BadRequestException('Pekerjaan tidak dapat dibatalkan.');
    this.setStatus(job, 'CANCELLING');
    this.lockedTargets.delete(job.target);
    job.cancelled = true;
    this.setStatus(job, 'CANCELLED');
    return job;
  }

  private async fetchExistingIds(pool: sql.ConnectionPool): Promise<{ usrIds: Set<string>; crdCsns: Set<string> }> {
    const usrIds = new Set<string>();
    const crdCsns = new Set<string>();
    const usrRes = await pool.request().query('SELECT USRID FROM dbo.T_USR WHERE USRID IS NOT NULL');
    for (const row of usrRes.recordset) if (row.USRID != null) usrIds.add(String(row.USRID));
    const crdRes = await pool.request().query("SELECT CRDCSN FROM dbo.T_CRD WHERE CRDCSN IS NOT NULL AND CRDCSN <> ''");
    for (const row of crdRes.recordset) if (row.CRDCSN != null) crdCsns.add(String(row.CRDCSN));
    return { usrIds, crdCsns };
  }

  private mssqlTypeFor(col: string): sql.ISqlType {
    return sql.NVarChar(sql.MAX);
  }

  // Ponytail: INSERT transaksional ke SQL Server BioStar sesuai DDL yang diverifikasi.
  // Kolom yang tidak ada di CSV dilewati (default DB akan digunakan).
  async startImport(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (job.status !== 'QUEUED') throw new BadRequestException('Pekerjaan belum dikonfirmasi atau sudah diproses.');
    if (!job.parsed) throw new BadRequestException('Data paket belum divalidasi. Jalankan parse terlebih dahulu.');
    const pool = await this.biostarConnect();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).query('SET XACT_ABORT ON');

      const { users, fingerprints, cards, relations } = job.parsed;
      const { usrIds, crdCsns } = await this.fetchExistingIds(pool);

      // Cek konflik USRID seluruh paket sebelum insert apa-apa (PRD §11).
      const planTargets = users.map(u => u.targetUsrId);
      const conflictingTargets = [...new Set(planTargets)].filter(t => usrIds.has(t));
      if (conflictingTargets.length) {
        throw new BadRequestException(`USRID tujuan sudah dipakai proses lain: ${conflictingTargets.join(', ')}. Buat preview ulang.`);
      }

      // Cek konflik kartu CSN (PRD §12): blokir seluruh import jika CRDCSN sudah ada di target.
      const conflictingCards = [...new Set(cards.map(c => c.crdCsn))].filter(cs => crdCsns.has(cs));
      if (conflictingCards.length) {
        throw new BadRequestException(`Kartu CSN sudah ada di target, impor diblokir: ${conflictingCards.join(', ')}.`);
      }

      const usrUidMap = new Map<string, number>();
      const crdUidMap = new Map<string, number>();

      // 1. Insert user (tanpa USRUID; IDENTITY dihasilkan DB).
      for (const u of users) {
        const cols: string[] = [];
        const vals: any[] = [];
        const add = (name: string, val: any) => { if (val !== null && val !== undefined) { cols.push(name); vals.push(val); } };
        add('USRID', u.targetUsrId);
        add('NM', u.nm);
        add('DEPARTMENT', u.department);
        add('TITLE', u.title);
        add('PWSTA', u.pwSta ?? 0);
        add('DEL', u.del ?? 'N');
        add('ISUSRGR', u.isUsrGr ?? 'N');
        add('LGNID', u.lgnId);
        add('PIN', u.pin);
        add('USRGRUID', u.usrGrUid);
        add('PERMUID', u.permUid);
        add('LSTMOD', u.lstMod);
        add('CREATEDT', u.createDt);
        add('USERIP', u.userIp);
        cols.push('IDXUSRID', 'IDXUSRIDNUM');
        vals.push(u.idxUsrId ?? null, u.idxUsrIdNum ?? null);
        const request = new sql.Request(tx);
        for (let i = 0; i < cols.length; i++) {
          request.input(`u${i}`, this.paramType(cols[i]), vals[i]);
        }
        const colsSql = cols.map(c => `[${c}]`).join(', ');
        const paramsSql = cols.map((_, i) => `@u${i}`).join(', ');
        const result = await request.query(`INSERT INTO dbo.T_USR (${colsSql}) VALUES (${paramsSql}); SELECT SCOPE_IDENTITY() AS newId`);
        const newId = this.lastIdentity(result);
        if (!Number.isFinite(newId)) throw new Error(`Gagal mengambil USRUID untuk ${u.targetUsrId}.`);
        usrUidMap.set(u.sourceUsrUid, newId);
      }

      // 2. Insert fingerprint (tanpa FNGPUID; TMPL0/TMPL1 sebagai image/varbinary).
      for (const f of fingerprints) {
        const usrUid = usrUidMap.get(f.sourceUsrUid);
        if (usrUid == null) throw new BadRequestException(`Fingerprint milik user yang tidak diimpor: ${f.sourceUsrUid}.`);
        const request = new sql.Request(tx);
        request.input('usrUid', sql.Int, usrUid)
          .input('fngpIdx', sql.Int, f.fngpIdx ?? 0)
          .input('tml0', sql.VarBinary(sql.MAX), f.tml0)
          .input('tml1', sql.VarBinary(sql.MAX), f.tml1)
          .input('dur', sql.Char(1), f.dur)
          .input('chs', sql.NVarChar(40), f.chs)
          .input('lstmod', sql.VarChar(40), f.lstmod);
        await request.query(`INSERT INTO dbo.T_FNGPTMPL(USRUID, FNGPIDX, TMPL0, TMPL1, DUR, CHS, LSTMOD)
          VALUES(@usrUid, @fngpIdx, @tml0, @tml1, @dur, @chs, @lstmod)`);
      }

      // 3. Insert kartu (tanpa CRDUID; CRDTYPUID=0 untuk CSN).
      for (const c of cards) {
        const request = new sql.Request(tx);
        request.input('crdTypUid', sql.Int, c.crdTypUid ?? 0)
          .input('crdCsn', sql.NVarChar(128), c.crdCsn)
          .input('asmUid', sql.Int, c.asmUid)
          .input('wgdfmUid', sql.Int, c.wgdfmUid)
          .input('wgdfmTver', sql.Int, c.wgdfmTver);
        const result = await request.query(`INSERT INTO dbo.T_CRD(CRDTYPUID, CRDCSN, ASMUID, WGDFMUID, WGDFMTVER)
          VALUES(@crdTypUid, @crdCsn, @asmUid, @wgdfmUid, @wgdfmTver); SELECT SCOPE_IDENTITY() AS newId`);
        const newId = this.lastIdentity(result);
        if (!Number.isFinite(newId)) throw new Error(`Gagal mengambil CRDUID untuk ${c.crdCsn}.`);
        crdUidMap.set(c.sourceCrdUid, newId);
      }

      // 4. Insert relasi user-kartu.
      for (const rel of relations) {
        const usrUid = usrUidMap.get(rel.sourceUsrUid);
        const crdUid = crdUidMap.get(rel.sourceCrdUid);
        if (usrUid == null || crdUid == null) throw new BadRequestException('Relasi merujuk user/kartu yang tidak diimpor.');
        const request = new sql.Request(tx);
        request.input('crdUid', sql.Int, crdUid)
          .input('usrUid', sql.Int, usrUid)
          .input('idx', sql.Int, rel.idx)
          .input('issddt', sql.DateTime2, rel.issddt)
          .input('expdt', sql.DateTime2, rel.expdt)
          .input('issdcnt', sql.Int, rel.issdcnt)
          .input('crdmsk', sql.Int, rel.crdmsk)
          .input('prdstdt', sql.DateTime2, rel.prdstdt)
          .input('prdeddt', sql.DateTime2, rel.prdeddt);
        await request.query(`INSERT INTO dbo.T_USRCRD(CRDUID, USRUID, IDX, ISSDDT, EXPDT, ISSDCNT, CRDMSK, PRDSTDT, PRDEDDT)
          VALUES(@crdUid, @usrUid, @idx, @issddt, @expdt, @issdcnt, @crdmsk, @prdstdt, @prdeddt)`);
      }

      await tx.commit();
      this.setStatus(job, 'COMMITTED');
      this.logger.log(`Impor paket ${job.packageId} committed ke BioStar target ${job.target}.`);
    } catch (error) {
      try { await tx.rollback(); } catch { /* rollback gagal, biarkan error utama */ }
      this.setStatus(job, 'FAILED');
      this.logger.error(`Impor paket ${job.packageId} gagal: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.lockedTargets.delete(job.target);
    }
  }

  private paramType(col: string): sql.ISqlType {
    const map: Record<string, sql.ISqlType> = {
      PWSTA: sql.Int(), DEL: sql.Char(1), ISUSRGR: sql.Char(1), USRGRUID: sql.Int(),
      PERMUID: sql.Int(), LSTMOD: sql.Int(), CREATEDT: sql.DateTime2(),
      IDXUSRID: sql.BigInt(), IDXUSRIDNUM: sql.BigInt(),
    };
    return map[col] ?? sql.NVarChar(sql.MAX);
  }

  getReport(jobId: string): ImportJob {
    return this.getJob(jobId);
  }

  private lastIdentity(result: any): number {
    const rs = result.recordset || (Array.isArray(result.recordsets) ? result.recordsets[result.recordsets.length - 1] : undefined) || [];
    return Number(rs[0]?.newId);
  }

  isTargetLocked(target: string): boolean { return this.lockedTargets.has(target); }
}

export const biostarService = new BiostarService();
