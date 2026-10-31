import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
export type Pc = {
  id: string;
  apiName: string;
  ipAPI: string;
  locationIDs: number[]
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Payload harus berupa objek JSON.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new BadRequestException(`${name} wajib diisi (maksimal 200 karakter).`);
  return value.trim();
}
// ID dibatasi ke SQL Server Int; jangan menerima pecahan atau konversi boolean/null.
export function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new BadRequestException(`${name} harus integer 0–2147483647.`);
  return value;
}
export function queryInteger(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new BadRequestException(`${name} harus integer ≥ 0.`);
  return integer(Number(value), name);
}
export function sqlDateTime(value: unknown, name: string): Date {
  const input = text(value, name).replace(' ', 'T');
  const normalized = input.length === 16 ? `${input}:00` : input;
  const date = new Date(`${normalized}Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized) || !Number.isFinite(+date) || date.getUTCFullYear() < 1753 || date.toISOString().slice(0, 19) !== normalized) throw new BadRequestException(`${name} harus tanggal/jam valid (YYYY-MM-DD HH:mm:ss), tahun 1753–9999.`);
  return date;
}
export function pcInput(value: unknown): Omit<Pc, 'id'> {
  const data = object(value);
  const apiName = text(data.apiName, 'Nama API');
  const ipAPI = text(data.ipAPI, 'IP API');
  if (isIP(ipAPI) !== 4) throw new BadRequestException(`API ${apiName} (${ipAPI}): gunakan alamat IPv4 valid, tanpa port atau path.`);
  if (!Array.isArray(data.locationIDs) || data.locationIDs.length > 1000) throw new BadRequestException(`API ${apiName} (${ipAPI}): locationIDs harus array, maksimal 1000 lokasi.`);
  return { apiName, ipAPI, locationIDs: [...new Set(data.locationIDs.map(id => integer(id, 'LocationID')))] };
}
