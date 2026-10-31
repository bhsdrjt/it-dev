import { Body, CanActivate, Controller, ExecutionContext, HttpCode, HttpException, Injectable, Post, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Request } from 'express';
import { object } from './validation';
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sesi tidak tersedia. Silakan login.');
    try {
      jwt.verify(header.slice(7), process.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' });
      return true;
    } catch {
      throw new UnauthorizedException('Sesi berakhir atau token tidak valid. Silakan login kembali.');
    }
  }
}
@Controller('auth')
export class AuthController {
  // ponytail: limiter satu proses; pakai rate limit reverse proxy saat memakai beberapa worker.
  private attempts = new Map<string, {
    count: number;
    until: number
  }>();
  @Post('login') @HttpCode(200)
  login(@Body() body: unknown, @Req() request: Request) {
    const now = Date.now();
    for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
    const ip = request.ip || 'unknown';
    const attempt = this.attempts.get(ip) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (attempt.count >= 10 || (!this.attempts.has(ip) && this.attempts.size >= 10000)) throw new HttpException('Terlalu banyak percobaan login. Coba lagi dalam 15 menit.', 429);
    attempt.count++;
    this.attempts.set(ip, attempt);
    const data = object(body);
    // Digest berukuran tetap memungkinkan timingSafeEqual meski panjang input berbeda.
    // Ini perbandingan kredensial dari environment, bukan skema penyimpanan password DB.
    const hash = (value: string) => createHash('sha256').update(value).digest();
    const username = typeof data.username === 'string' && data.username.length <= 200 ? data.username : '';
    const password = typeof data.password === 'string' && data.password.length <= 1000 ? data.password : '';
    const userOk = timingSafeEqual(hash(username), hash(process.env.AUTH_USERNAME!));
    const passOk = timingSafeEqual(hash(password), hash(process.env.AUTH_PASSWORD!));
    if (!userOk || !passOk) throw new UnauthorizedException('Username atau password salah');
    this.attempts.delete(ip);
    return { token: jwt.sign({}, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '12h', subject: username, issuer: 'it-dev-ops', audience: 'it-dev-ops-ui' }), expiresIn: 43200 };
  }
}
