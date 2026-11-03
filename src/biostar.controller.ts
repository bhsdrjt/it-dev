import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors, ServiceUnavailableException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtGuard, RequirePermissions } from './auth';
import { biostarService, ImportJob, planUserIds } from './biostar';
import { object, text } from './validation';

@Controller('biostar/imports')
@UseGuards(JwtGuard)
export class BiostarImportController {
  @RequirePermissions('biostar.import.view')
  @Get('connection')
  async connection(): Promise<{ ok: boolean; target: string; message: string }> {
    const target = process.env.BIOSTAR_DB_SERVER || '(belum dikonfigurasi)';
    if (!process.env.BIOSTAR_DB_SERVER || !process.env.BIOSTAR_DB_DATABASE || !process.env.BIOSTAR_DB_USER || !process.env.BIOSTAR_DB_PASSWORD) {
      return { ok: false, target, message: 'BIOSTAR_DB_* belum diisi di .env.' };
    }
    try {
      const pool = await biostarService.checkConnection();
      await pool.request().query('SELECT 1 AS ok');
      return { ok: true, target, message: 'Koneksi ke database BioStar terhubung.' };
    } catch (error) {
      return { ok: false, target, message: error instanceof Error ? error.message : 'Koneksi gagal.' };
    }
  }

  @RequirePermissions('biostar.import.upload')
  @Post()
  @UseInterceptors(FileInterceptor('zip'))
  async upload(@UploadedFile() zip: unknown, @Body() body: unknown): Promise<{ jobId: string; status: string; target: string }> {
    const file = zip as { buffer?: Buffer; mimetype?: string; originalname?: string; size?: number } | undefined;
    if (!file || !file.buffer) throw new BadRequestException('ZIP wajib diunggah.');
    if (file.mimetype !== 'application/zip' && file.mimetype !== 'application/x-zip-compressed' && !String(file.originalname ?? '').toLowerCase().endsWith('.zip')) {
      throw new BadRequestException('Berkas harus ZIP.');
    }
    if (typeof file.size !== 'number' || file.size > 100 * 1024 * 1024) throw new BadRequestException('ZIP melebihi batas upload 100 MB.');
    const data = object(body ?? {});
    const packageId = text(data.packageId, 'Package ID');
    if (!process.env.BIOSTAR_DB_SERVER) throw new ServiceUnavailableException('Target BioStar belum dikonfigurasi backend (BIOSTAR_DB_SERVER).');
    const job = biostarService.createJob(packageId, process.env.BIOSTAR_DB_SERVER!);
    try {
      await biostarService.parsePackage(job.id, file.buffer);
    } catch (error) {
      biostarService.cancel(job.id).catch(() => undefined);
      throw error;
    }
    return { jobId: job.id, status: job.status, target: job.target };
  }

  @RequirePermissions('biostar.import.view')
  @Get()
  list(): ImportJob[] {
    return biostarService.listJobs();
  }

  @RequirePermissions('biostar.import.view')
  @Get(':id')
  get(@Param('id') id: string): ImportJob {
    return biostarService.getJob(id);
  }

  @RequirePermissions('biostar.import.view')
  @Get(':id/preview')
  preview(@Param('id') id: string, @Query('revision') revision?: unknown): ImportJob {
    const job = biostarService.getJob(id);
    if (revision !== undefined) {
      const rev = Number(revision);
      if (!Number.isFinite(rev) || rev < 0) throw new BadRequestException('Revisi harus angka non-negatif.');
      if (!job.preview || job.preview.revision !== rev) throw new BadRequestException('Revisi preview tidak tersedia.');
    }
    return job;
  }

  @RequirePermissions('biostar.import.view')
  @Get(':id/detail')
  detail(@Param('id') id: string): { fingerprints: unknown[]; cards: unknown[]; relations: unknown[] } {
    const job = biostarService.getJob(id);
    if (!job.parsed) throw new BadRequestException('Data paket belum tersedia.');
    return {
      fingerprints: job.parsed.fingerprints.map(f => ({
        sourceUsrUid: f.sourceUsrUid, fngpIdx: f.fngpIdx, dur: f.dur,
        tml0: f.tml0 ? f.tml0.toString('base64') : null, tml1: f.tml1 ? f.tml1.toString('base64') : null,
        chs: f.chs, lstmod: f.lstmod,
      })),
      cards: job.parsed.cards,
      relations: job.parsed.relations,
    };
  }

  @RequirePermissions('biostar.import.confirm')
  @Post(':id/confirm')
  async confirm(@Param('id') id: string, @Body() body: unknown): Promise<ImportJob> {
    const data = object(body);
    const revision = data.revision;
    if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0) throw new BadRequestException('Revisi wajib diisi.');
    return biostarService.confirm(id, revision);
  }

  @RequirePermissions('biostar.import.cancel')
  @Post(':id/cancel')
  async cancel(@Param('id') id: string): Promise<ImportJob> {
    return biostarService.cancel(id);
  }

  @RequirePermissions('biostar.import.start')
  @Post(':id/start')
  async start(@Param('id') id: string): Promise<void> {
    return biostarService.startImport(id);
  }

  @RequirePermissions('biostar.import.report')
  @Get(':id/report')
  report(@Param('id') id: string): ImportJob {
    return biostarService.getReport(id);
  }
}
