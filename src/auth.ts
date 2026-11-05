import { BadRequestException, Body, CallHandler, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpCode, HttpException, Injectable, Module, NestInterceptor, Param, Post, Put, Query, Req, SetMetadata, ServiceUnavailableException, UnauthorizedException, UseGuards, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Request } from 'express';
import { Observable, from, lastValueFrom } from 'rxjs';
import { AuthDbService, AuthUser, passwordHash, passwordMatches } from './auth-db';
import { integer, object, queryInteger, text } from './validation';
export const PERMISSIONS_METADATA = 'auth.permissions';
// Shared reference routes accept any listed permission; empty list explicitly allows authenticated access.
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_METADATA, codes);
export const RequireAdmin = () => SetMetadata('auth.admin', true);
export type AuthRequest = Request & { auth: AuthUser & { userId: number } };
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly db: AuthDbService, private readonly reflector: Reflector) { }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sesi tidak tersedia. Silakan login.');
    let payload: jwt.JwtPayload;
    try {
      const verified = jwt.verify(header.slice(7), process.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
      if (typeof verified === 'string' || !verified.sub || !/^\d+$/.test(verified.sub) || !Number.isSafeInteger(verified.ver)) throw new Error('Invalid claims');
      payload = verified;
    } catch { throw new UnauthorizedException('Sesi berakhir atau token tidak valid. Silakan login kembali.'); }
    const id = Number(payload.sub);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new UnauthorizedException('Token tidak valid.');
    const user = await this.db.user(id);
    if (!user || user.tokenVersion !== payload.ver) throw new UnauthorizedException('Sesi dicabut. Silakan login kembali.');
    request.auth = { ...user, userId: user.id };
    if (this.reflector.getAllAndOverride<boolean>('auth.admin', [context.getHandler(), context.getClass()]) && !request.auth.roles.includes('admin')) throw new ForbiddenException('Hanya admin dapat membuka UserAudit.');
    const codes = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_METADATA, [context.getHandler(), context.getClass()]);
    if (codes === undefined || (codes.length && !codes.some(code => user.permissions.includes(code)))) throw new ForbiddenException('Akses tidak diizinkan.');
    return true;
  }
}
@Injectable()
export class AuthAuditInterceptor implements NestInterceptor {
  constructor(private readonly db: AuthDbService) { }
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || /\/auth\/me\/?$/.test(request.path)) return next.handle();
    const readOnly = request.method === 'GET' || /\/apis\/ping\/?$/.test(request.path);
    return from((async () => {
      const operationId = randomBytes(16).toString('hex');
      const action = `${request.method} ${request.route?.path || request.path}`.slice(0, 100);
      const identifiers: Record<string, string | number> = {};
      const body = request.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const key of ['coalDeliveryNumber', 'tonnageId', 'kind', 'loadingTonnageId', 'dumpingTonnageId', 'ctFinalDumpingTonnageId', 'rawTonnageId', 'apiId', 'equipmentID', 'locationID', 'nextDT']) {
          const value: unknown = body[key];
          if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) identifiers[key] = value;
        }
      }
      const query: Record<string, string> = {};
      if (request.method === 'GET') {
        for (const key of ['activeOnly', 'apiId', 'equipmentId', 'coalDeliveryNumber', 'nextDT', 'kind', 'dumpingTonnageId', 'start', 'end', 'starttime', 'endtime', 'code', 'truck', 'cdn', 'severity', 'category']) {
          const value: unknown = request.query?.[key];
          if (typeof value === 'string') query[key] = value.slice(0, 200);
        }
      }
      // Never serialize headers, whole bodies, SQL responses, or arbitrary query parameters.
      const target = JSON.stringify({ ...identifiers, path: request.path, ...(request.method === 'GET' ? { query } : {}) });
      await this.db.audit(request.auth.id, action, target, operationId, 'started');
      let result: unknown;
      try {
        result = await lastValueFrom(next.handle());
      } catch (error) {
        const outcome = readOnly || (error instanceof HttpException && error.getStatus() < 500) ? 'failed' : 'unknown';
        await this.db.audit(request.auth.id, action, target, operationId, outcome).catch(() => undefined);
        throw error;
      }
      try {
        await this.db.audit(request.auth.id, action, target, operationId, 'succeeded');
      } catch {
        if (readOnly) throw new ServiceUnavailableException('Pembacaan selesai, tetapi audit penyelesaian gagal.');
        // Durable started row remains; never label an applied operation failed.
        throw new ServiceUnavailableException('Operasi mungkin sudah diterapkan, tetapi audit penyelesaian gagal. Periksa data sebelum mencoba kembali.');
      }
      return result;
    })());
  }
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1000) throw new BadRequestException('Password harus 12–1000 karakter.');
  return value;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100) throw new BadRequestException('Daftar ID harus array, maksimal 100.');
  return [...new Set(value.map(v => integer(v, 'ID')))];
}
@Controller('auth')
export class AuthController {
  constructor(private readonly db: AuthDbService) { }
  // ponytail: limiter satu proses; pakai rate limit reverse proxy saat memakai beberapa worker.
  private attempts = new Map<string, { count: number; until: number }>();
  private dummyHash = passwordHash(randomBytes(32).toString('hex'));
  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: Request) {
    const now = Date.now();
    for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
    const ip = request.ip || 'unknown';
    const attempt = this.attempts.get(ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (attempt.count >= 10 || (!this.attempts.has(ip) && this.attempts.size >= 10000)) throw new HttpException('Terlalu banyak percobaan login. Coba lagi dalam 15 menit.', 429);
    attempt.count++;
    this.attempts.set(ip, attempt);
    const data = object(body);
    if (typeof data.username !== 'string' || !data.username.trim() || data.username.length > 200 || typeof data.password !== 'string' || !data.password || data.password.length > 1000) throw new UnauthorizedException('Username atau password salah');
    const credentials = await this.db.credentials(data.username.trim());
    const matches = await passwordMatches(data.password, credentials?.passwordHash ?? await this.dummyHash);
    if (!credentials || !matches) throw new UnauthorizedException('Username atau password salah');
    const user = await this.db.user(credentials.id);
    if (!user || user.tokenVersion !== credentials.tokenVersion) throw new UnauthorizedException('Username atau password salah');
    await this.db.audit(user.id, 'auth.login', String(user.id));
    this.attempts.delete(ip);
    return { token: jwt.sign({ ver: user.tokenVersion }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '12h', subject: String(user.id), issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' }), expiresIn: 43200 };
  }
  @Get('me') @UseGuards(JwtGuard) @RequirePermissions()
  me(@Req() request: AuthRequest) {
    const { userId, username, displayName, permissions, roles } = request.auth;
    return { userId, username, displayName, permissions, roles };
  }
}
@Controller('auth/admin')
@UseGuards(JwtGuard)
@RequirePermissions('access.manage')
export class AccessController {
  constructor(private readonly db: AuthDbService) { }
  @Get('audit') @RequirePermissions() @RequireAdmin()
  audit(@Query() query: Record<string, unknown>) { return this.db.auditRows(query); }
  @Get('users') @UseInterceptors(AuthAuditInterceptor) async users() {
    const sets = await this.db.users();
    return { users: sets[0], userRoles: sets[1] };
  }
  @Get('roles') @UseInterceptors(AuthAuditInterceptor) async roles() {
    const sets = await this.db.roles();
    return { roles: sets[0], permissions: sets[1], rolePermissions: sets[2] };
  }
  @Post('roles') createRole(@Req() request: AuthRequest, @Body() body: unknown) {
    const { name } = object(body);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new BadRequestException('Nama role wajib 1–100 karakter tanpa karakter kontrol.');
    return this.db.createRole(request.auth.id, name.trim());
  }
  @Post('users') create(@Req() request: AuthRequest, @Body() body: unknown) {
    const data = object(body);
    return this.db.createUser(request.auth.id, text(data.username, 'Username'), text(data.displayName, 'Nama'), password(data.password), ids(data.roleIds));
  }
  @Put('users/:id') update(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    const data = object(body);
    if (typeof data.isActive !== 'boolean') throw new BadRequestException('isActive harus boolean.');
    return this.db.updateUser(request.auth.id, queryInteger(id, 'User ID'), text(data.displayName, 'Nama'), data.isActive, data.password === undefined ? undefined : password(data.password));
  }
  @Put('users/:id/roles') userRoles(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.db.assignments(request.auth.id, 'user', queryInteger(id, 'User ID'), ids(object(body).roleIds));
  }
  @Put('roles/:id/permissions') rolePermissions(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.db.assignments(request.auth.id, 'role', queryInteger(id, 'Role ID'), ids(object(body).permissionIds));
  }
}
@Module({ controllers: [AuthController, AccessController], providers: [AuthDbService, JwtGuard, AuthAuditInterceptor], exports: [AuthDbService, JwtGuard, AuthAuditInterceptor] })
export class AuthModule { }
