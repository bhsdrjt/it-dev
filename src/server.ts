import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request, Response, NextFunction } from 'express';
import { resolve } from 'node:path';
import { ApiController } from './api';
import { AuthController, JwtGuard } from './auth';
import { DbService } from './db';
import { PcService } from './pc';
import { PcRegistryService } from './registry';
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status >= 500) Logger.error(error, 'HTTP');
    const detail = error instanceof HttpException ? error.getResponse() : null;
    const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && 'message' in detail ? detail.message : 'Terjadi kesalahan server. Hubungi administrator.';
    const queries = detail && typeof detail === 'object' && 'queries' in detail && Array.isArray(detail.queries) ? detail.queries : [];
    response.status(status).json({ statusCode: status, message, ...(queries.length ? { queries } : {}) });
  }
}
@Module({ controllers: [AuthController, ApiController], providers: [JwtGuard, DbService, PcService, PcRegistryService] })
export class AppModule { }
export function validateEnvironment() {
  for (const key of ['JWT_SECRET', 'AUTH_USERNAME', 'AUTH_PASSWORD', 'DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD']) {
    if (!process.env[key]?.trim()) throw new Error(`Environment ${key} wajib diisi. Salin .env.example ke .env.`);
  }
  if (process.env.JWT_SECRET!.length < 32) throw new Error('JWT_SECRET minimal 32 karakter acak.');
  if (process.env.AUTH_USERNAME!.length > 200 || process.env.AUTH_PASSWORD!.length > 1000) throw new Error('Kredensial melebihi batas panjang.');
  for (const key of ['PORT', 'DB_PORT', 'PING_TIMEOUT_MS', 'LOOKUP_TIMEOUT_MS']) {
    const value = process.env[key];
    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > (key.endsWith('PORT') ? 65535 : 60000))) throw new Error(`${key} tidak valid.`);
  }
  if (process.env.API_BASE_PATH && !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(process.env.API_BASE_PATH)) throw new Error('API_BASE_PATH harus path lokal tanpa host atau query.');
}
// Factory dipisah dari listen agar tes dapat menjalankan server pada port sementara.
export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '32kb' });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
  app.useStaticAssets(resolve('public'), { index: 'index.html', dotfiles: 'deny' });
  app.enableShutdownHooks();
  return app;
}
if (require.main === module) {
  void (async () => {
    validateEnvironment();
    const app = await createApp();
    await app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
    Logger.log(`IT Dev Ops ready on port ${process.env.PORT || 3000}`, 'Bootstrap');
  })().catch(error => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
