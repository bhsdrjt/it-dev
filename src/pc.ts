import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'node:net';
import axios from 'axios';
import ping from 'ping';
import { Pc } from './validation';
export type Check = {
  equipmentID: number;
  locationID: number;
  isGenerateCDN: boolean
};
function lower(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key.toLowerCase(), val]));
}
// API lama dapat membungkus koleksi dan memakai kapitalisasi berbeda.
// Batasi pembukaan wrapper; respons salah format harus gagal, bukan dianggap data kosong.
export function normalizeChecks(value: unknown): Check[] {
  for (let depth = 0; !Array.isArray(value) && depth < 5; depth++) {
    const wrapped = lower(value);
    const key = ['data', 'items', 'result'].find(key => key in wrapped);
    if (!key) throw new Error('Expected array or data/items/result wrapper');
    value = wrapped[key];
  }
  if (!Array.isArray(value)) throw new Error('Invalid equipment checks');
  return value.map(item => {
    const row = lower(item);
    const id = (val: unknown) => {
      if ((typeof val !== 'number' && (typeof val !== 'string' || !/^\d+$/.test(val))) || !Number.isSafeInteger(Number(val)) || Number(val) < 0) throw new Error('Invalid check ID');
      return Number(val);
    };
    const flag = row.isgeneratecdn;
    if (![true, false, 1, 0, 'true', 'false', '1', '0'].includes(flag as never)) throw new Error('Invalid isGenerateCDN');
    return { equipmentID: id(row.equipmentid), locationID: id(row.locationid), isGenerateCDN: flag === true || flag === 1 || flag === 'true' || flag === '1' };
  });
}
@Injectable()
export class PcService {
  private readonly logger = new Logger(PcService.name);
  private get timeout() {
    return Number(process.env.PING_TIMEOUT_MS || 2000);
  }
  label(pc: Pc) {
    return `API ${pc.apiName} (${pc.ipAPI})`;
  }
  tcp(pc: Pc): Promise<number | null> {
    return new Promise(resolve => {
      const start = performance.now();
      const socket = new Socket();
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(ok ? Math.round(performance.now() - start) : null);
      };
      socket.setTimeout(this.timeout);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
      socket.connect(80, pc.ipAPI);
    });
  }
  async status(pc: Pc) {
    try {
      const result = await ping.promise.probe(pc.ipAPI, { timeout: Math.ceil(this.timeout / 1000), min_reply: 1 });
      if (result.alive) return { ...pc, online: true, latency: Number.isFinite(Number(result.time)) ? Number(result.time) : null, method: 'icmp' };
    } catch {
      // Utilitas ICMP bisa tidak tersedia; tetap coba koneksi TCP port 80.
    }
    const latency = await this.tcp(pc);
    return { ...pc, online: latency !== null, latency, method: latency !== null ? 'tcp' : null };
  }
  async requireTcp(pc: Pc) {
    if (await this.tcp(pc) === null) throw new ServiceUnavailableException(`${this.label(pc)} offline atau port 80 tidak terjangkau.`);
  }
  async request(pc: Pc, method: 'GET' | 'POST', options: {
    params?: Record<string, number>;
    data?: unknown;
    timeout?: number
  } = {}) {
    const base = (process.env.API_BASE_PATH || '/SNCAutoWBLocalAPI').replace(/\/$/, '');
    try {
      const response = await axios.request({
        url: `http://${pc.ipAPI}${base}/api/EquipmentChecks${method === 'POST' ? '/upsert' : ''}`,
        method, timeout: options.timeout ?? 10000, params: options.params, data: options.data,
        maxRedirects: 0, proxy: false, maxContentLength: 10 * 1024 * 1024, maxBodyLength: 1024 * 1024,
      });
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      this.logger.error(`${this.label(pc)} request failed: ${axios.isAxiosError(error) ? error.code : 'unknown'} HTTP ${status ?? '-'}`);
      const message = method === 'POST'
        ? `${this.label(pc)} gagal mengonfirmasi penyimpanan. Muat ulang data sebelum mencoba kirim lagi.`
        : `${this.label(pc)} gagal dihubungi${status ? ` (HTTP ${status})` : ' atau waktu tunggu habis'}.`;
      throw new BadGatewayException(message);
    }
  }
  async checks(pc: Pc, params?: Record<string, number>, timeout?: number) {
    const data = await this.request(pc, 'GET', { params, timeout });
    try {
      return normalizeChecks(data);
    }
    catch (error) {
      this.logger.error(`${this.label(pc)} invalid response`, error);
      throw new BadGatewayException(`${this.label(pc)} mengirim format equipment checks yang tidak valid.`);
    }
  }
}
