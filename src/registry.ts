import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pc, pcInput, text } from './validation';
@Injectable()
export class PcRegistryService {
  private readonly file = resolve(process.env.APIS_FILE || 'data/apis.json');
  private queue: Promise<unknown> = Promise.resolve();
  private readonly logger = new Logger(PcRegistryService.name);
  async list(): Promise<Pc[]> {
    try {
      const raw: unknown = JSON.parse((await readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''));
      if (!Array.isArray(raw)) throw new Error('Registry must be an array');
      const rows = raw.map(row => ({ id: text(row?.id, 'ID API'), ...pcInput(row) }));
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate registry IDs');
      return rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.logger.error('Registry read failed', error);
      throw new ServiceUnavailableException('Registry API tidak dapat dibaca. Periksa file JSON di server; data tidak ditimpa.');
    }
  }
  async get(id: string): Promise<Pc> {
    const row = (await this.list()).find(pc => pc.id === id);
    if (!row) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
    return row;
  }
  mutate(action: (rows: Pc[]) => unknown): Promise<unknown> {
    // ponytail: satu proses server; gunakan DB/lock lintas proses sebelum menjalankan beberapa worker.
    const task = this.queue.then(async () => {
      const rows = await this.list();
      const result = action(rows);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        // Tulis dan flush file baru dahulu; registry lama diganti setelah seluruh isi siap.
        try {
          await file.writeFile(JSON.stringify(rows, null, 2) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, this.file);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        this.logger.error('Registry write failed', error);
        throw new ServiceUnavailableException('Registry API gagal disimpan. File sebelumnya tetap dipertahankan.');
      }
      return result;
    });
    // Pulihkan antrean setelah gagal, tetapi teruskan kegagalan task ke pemanggil.
    // Tanpa catch ini, satu gagal tulis akan memblokir semua mutasi berikutnya.
    this.queue = task.catch(() => undefined);
    return task;
  }
  save(data: Omit<Pc, 'id'>, id?: string) {
    return this.mutate(rows => {
      const pc = { ...data, id: id ?? randomUUID() };
      if (id) {
        const index = rows.findIndex(row => row.id === id);
        if (index < 0) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
        rows[index] = pc;
      } else rows.push(pc);
      return pc;
    });
  }
  remove(id: string) {
    return this.mutate(rows => {
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) throw new NotFoundException(`API ID ${id} tidak ditemukan.`);
      const [pc] = rows.splice(index, 1);
      return { message: `API ${pc.apiName} (${pc.ipAPI}) dihapus dari registry.` };
    });
  }
}
