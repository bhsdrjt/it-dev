import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import sql from 'mssql';
import { AuthDbService } from './auth-db';
import { Pc, object, pcInput, text } from './validation';

function registryId(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new BadRequestException('ID API harus integer 1–2147483647.');
  return String(value);
}
export function registryInput(value: unknown, legacy = false): Pc[] {
  if (!Array.isArray(value)) throw new BadRequestException('Registry harus array.');
  const rows = value.map(value => {
    const row = object(value);
    const pc = { id: legacy && typeof row.id === 'string' ? text(row.id, 'ID API') : registryId(row.id), ...pcInput(row) };
    if (pc.locationIDs.length !== (row.locationIDs as unknown[]).length) throw new BadRequestException('LocationID duplikat.');
    return pc;
  });
  if (new Set(rows.map(row => row.id.replace(/ +$/, ''))).size !== rows.length) throw new BadRequestException('ID API duplikat.');
  return rows;
}
function unavailable(): never {
  throw new ServiceUnavailableException('Database registry API tidak tersedia. Periksa data sebelum mencoba mutasi lagi.');
}
@Injectable()
export class PcRegistryService {
  constructor(private readonly db: AuthDbService) { }
  private async read(request: sql.Request, lock = false): Promise<Pc[]> {
    const result = await request.query(`SELECT Id AS id, ApiName AS apiName, IpAPI AS ipAPI, LocationIDs AS locationIDs
      FROM dbo.ApiTargets ${lock ? 'WITH (TABLOCKX, HOLDLOCK)' : ''}
      ORDER BY ApiName, Id`);
    return registryInput(result.recordset.map(row => {
      if (typeof row.locationIDs !== 'string') throw new Error('LocationIDs harus JSON.');
      return { ...row, locationIDs: JSON.parse(row.locationIDs) };
    }));
  }
  async list(): Promise<Pc[]> {
    try { return await this.read((await this.db.connect()).request()); }
    catch { unavailable(); }
  }
  async get(id: string): Promise<Pc> {
    registryId(id);
    const row = (await this.list()).find(pc => pc.id === id);
    if (!row) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
    return row;
  }
  private async mutate<T>(action: (tx: sql.Transaction, rows: Pc[]) => Promise<T>): Promise<T> {
    let tx: sql.Transaction | undefined;
    let begun = false;
    try {
      tx = new sql.Transaction(await this.db.connect());
      await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      begun = true;
      const result = await action(tx, await this.read(new sql.Request(tx), true));
      await tx.commit();
      return result;
    } catch (error) {
      if (begun) await tx!.rollback().catch(() => undefined);
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      unavailable();
    }
  }
  private async write(tx: sql.Transaction, pc: Omit<Pc, 'id'>, id?: string): Promise<Pc> {
    const request = new sql.Request(tx).input('name', sql.NVarChar(200), pc.apiName)
      .input('ip', sql.VarChar(15), pc.ipAPI).input('locations', sql.NVarChar(sql.MAX), JSON.stringify(pc.locationIDs));
    if (id !== undefined) request.input('id', sql.Int, Number(registryId(id)));
    const result = await request.query(id !== undefined
      ? 'UPDATE dbo.ApiTargets SET ApiName=@name, IpAPI=@ip, LocationIDs=@locations OUTPUT inserted.Id AS id WHERE Id=@id'
      : 'INSERT dbo.ApiTargets(ApiName,IpAPI,LocationIDs) OUTPUT inserted.Id AS id VALUES(@name,@ip,@locations)');
    return { ...pc, id: registryId(result.recordset[0].id) };
  }
  save(data: Omit<Pc, 'id'>, id?: string): Promise<Pc> {
    if (id !== undefined) registryId(id);
    const pc = pcInput(data);
    return this.mutate(async (tx, rows) => {
      const existing = rows.find(row => row.id === id);
      if (id !== undefined && !existing) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
      return this.write(tx, pc, id);
    });
  }
  remove(id: string) {
    registryId(id);
    return this.mutate(async (tx, rows) => {
      const pc = rows.find(row => row.id === id);
      if (!pc) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
      await new sql.Request(tx).input('id', sql.Int, Number(id)).query('DELETE dbo.ApiTargets WHERE Id=@id');
      return { message: `API ${pc.apiName} (${pc.ipAPI}) dihapus dari registry.` };
    });
  }
  import(value: unknown) {
    const input = registryInput(value, true);
    const overlaps = (a: Pc, b: Pc) => a.apiName.toLowerCase() === b.apiName.toLowerCase() || a.ipAPI === b.ipAPI;
    if (input.some((pc, index) => input.slice(0, index).some(row => overlaps(row, pc)))) throw new BadRequestException('Nama/IP API impor ambigu atau duplikat.');
    return this.mutate(async (tx, rows) => {
      let inserted = 0;
      for (const pc of input) {
        const matches = rows.filter(row => overlaps(row, pc));
        if (matches.length) {
          const existing = matches[0];
          if (matches.length !== 1 || existing.apiName !== pc.apiName || existing.ipAPI !== pc.ipAPI || JSON.stringify(existing.locationIDs) !== JSON.stringify(pc.locationIDs)) throw new ConflictException(`Konflik registry ${pc.apiName}; tidak ditimpa.`);
        } else {
          rows.push(await this.write(tx, pc));
          inserted++;
        }
      }
      return { inserted, skipped: input.length - inserted };
    });
  }
}
