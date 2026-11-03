import { BadRequestException, ConflictException, HttpException, Injectable, OnModuleDestroy, OnModuleInit, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import sql from 'mssql';
import { queryInteger, sqlDateTime, text } from './validation';
function unavailable(error: unknown): never {
  if (error instanceof HttpException) throw error;
  throw new ServiceUnavailableException('Database autentikasi tidak tersedia.');
}
const SCRYPT = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => derive(password, salt, 64, SCRYPT, (error, key) => error ? reject(error) : resolve(key)));
}
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt) as Buffer;
  return `scrypt$16384$8$5$${salt}$${key.toString('hex')}`;
}
export async function passwordMatches(password: string, hash: string): Promise<boolean> {
  if (!/^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash)) return false;
  const [, , , , salt, hex] = hash.split('$');
  return timingSafeEqual(await scrypt(password, salt) as Buffer, Buffer.from(hex, 'hex'));
}
export type AuthUser = { id: number; username: string; displayName: string; tokenVersion: number; roles: string[]; permissions: string[] };
@Injectable()
export class AuthDbService implements OnModuleDestroy, OnModuleInit {
  private pool?: sql.ConnectionPool;
  private connecting?: Promise<sql.ConnectionPool>;
  async connect(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (this.connecting) return this.connecting;
    const pool = new sql.ConnectionPool({
      server: process.env.DB_SERVER!, database: process.env.AUTH_DB_DATABASE || 'ITMonitor',
      user: process.env.AUTH_DB_USER!, password: process.env.AUTH_DB_PASSWORD!,
      port: Number(process.env.DB_PORT || 1433), connectionTimeout: 5000, requestTimeout: 10000,
      pool: { min: 0, max: 5, idleTimeoutMillis: 30000 },
      options: { encrypt: process.env.DB_ENCRYPT !== 'false', trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true' },
    });
    pool.on('error', () => { if (this.pool === pool) this.pool = undefined; void pool.close().catch(() => undefined); });
    this.connecting = pool.connect().then(() => this.pool = pool).catch(async () => {
      await pool.close().catch(() => undefined);
      throw new ServiceUnavailableException('Database autentikasi tidak tersedia.');
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async onModuleDestroy() { if (this.connecting) await this.connecting.catch(() => undefined); await this.pool?.close(); }
  async onModuleInit() {
    await this.seedPermissions();
  }
  private async seedPermissions() {
    const permissions = [
      'biostar.import.view', 'biostar.import.upload', 'biostar.import.mapping',
      'biostar.import.validate', 'biostar.import.confirm', 'biostar.import.cancel',
      'biostar.import.start', 'biostar.import.report',
    ];
    try {
      const existing = await this.connect().then(pool => pool.request()
        .query("SELECT Name FROM dbo.AuthPermissions WHERE Name IN ('" + permissions.join("','") + "')"));
      const have = new Set(existing.recordset.map((row: any) => row.Name));
      const missing = permissions.filter(p => !have.has(p));
      if (!missing.length) return;
      const pool = await this.connect();
      for (const p of missing) {
        await pool.request().input('name', sql.NVarChar(200), p)
          .query("INSERT dbo.AuthPermissions(Name) OUTPUT inserted.Id AS id VALUES(@name)");
      }
    } catch {
      // Tabel AuthPermissions mungkin belum tersedia pada awalnya; abaikan agar startup tidak gagal.
    }
  }
  async credentials(username: string) {
    const result = await (await this.connect()).request().input('username', sql.NVarChar(200), username)
      .query('SELECT Id AS id, PasswordHash AS passwordHash, TokenVersion AS tokenVersion FROM dbo.AuthUsers WHERE Username=@username AND IsActive=1').catch(unavailable);
    return result.recordset[0] as { id: number; passwordHash: string; tokenVersion: number } | undefined;
  }
  async user(id: number): Promise<AuthUser | undefined> {
    const result = await (await this.connect()).request().input('id', sql.Int, id).query(`
      SELECT Id AS id, Username AS username, DisplayName AS displayName, TokenVersion AS tokenVersion FROM dbo.AuthUsers WHERE Id=@id AND IsActive=1;
      SELECT r.Name AS name FROM dbo.AuthRoles r JOIN dbo.AuthUserRoles ur ON ur.RoleId=r.Id WHERE ur.UserId=@id;
      SELECT DISTINCT p.Name AS name FROM dbo.AuthPermissions p JOIN dbo.AuthRolePermissions rp ON rp.PermissionId=p.Id JOIN dbo.AuthUserRoles ur ON ur.RoleId=rp.RoleId WHERE ur.UserId=@id;`).catch(unavailable);
    const sets = result.recordsets as sql.IRecordSet<any>[];
    return sets[0][0] ? { ...sets[0][0], roles: sets[1].map(r => r.name), permissions: sets[2].map(r => r.name) } : undefined;
  }
  async audit(actor: number, action: string, target: string, operationId: string | null = null, outcome = 'succeeded') {
    await (await this.connect()).request().input('actor', sql.Int, actor).input('action', sql.NVarChar(100), action).input('target', sql.NVarChar(sql.MAX), target)
      .input('operation', sql.VarChar(32), operationId).input('outcome', sql.VarChar(20), outcome)
      .query('INSERT dbo.UserAudit(ActorUserId,Action,Target,OperationId,Outcome) VALUES(@actor,@action,@target,@operation,@outcome)').catch(unavailable);
  }
  async auditRows(query: Record<string, unknown>) {
    const limit = query.limit === undefined ? 50 : queryInteger(query.limit, 'Limit');
    const offset = query.offset === undefined ? 0 : queryInteger(query.offset, 'Offset');
    if (limit < 1 || limit > 100 || offset > 1000000) throw new BadRequestException('Limit harus 1–100; offset maksimal 1000000.');
    const user = query.user === undefined ? null : text(query.user, 'User');
    const outcome = query.outcome === undefined ? null : text(query.outcome, 'Outcome');
    if (outcome !== null && !['started', 'succeeded', 'failed', 'unknown'].includes(outcome)) throw new BadRequestException('Outcome tidak valid.');
    const start = query.start === undefined ? null : sqlDateTime(query.start, 'Start');
    const end = query.end === undefined ? null : sqlDateTime(query.end, 'End');
    if (start && end && start >= end) throw new BadRequestException('End harus setelah start.');
    const result = await (await this.connect()).request()
      .input('limit', sql.Int, limit + 1).input('offset', sql.Int, offset)
      .input('user', sql.NVarChar(200), user).input('outcome', sql.VarChar(20), outcome)
      .input('start', sql.DateTime2, start).input('end', sql.DateTime2, end)
      .query(`SELECT CONVERT(varchar(20), a.Id) AS id, a.ActorUserId AS actorUserId,
        u.Username AS username, u.DisplayName AS displayName, a.Action AS action,
        a.Target AS target, a.OperationId AS operationId, a.Outcome AS outcome, a.CreatedAt AS createdAt
        FROM dbo.UserAudit a LEFT JOIN dbo.AuthUsers u ON u.Id=a.ActorUserId
        WHERE (@user IS NULL OR u.Username=@user) AND (@outcome IS NULL OR a.Outcome=@outcome)
          AND (@start IS NULL OR a.CreatedAt>=@start) AND (@end IS NULL OR a.CreatedAt<@end)
        ORDER BY a.CreatedAt DESC, a.Id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`).catch(unavailable);
    return { rows: result.recordset.slice(0, limit), limit, offset, hasMore: result.recordset.length > limit && offset + limit <= 1000000 };
  }
  async users() {
    return (await (await this.connect()).request().query(`SELECT Id AS id, Username AS username, DisplayName AS displayName, IsActive AS isActive, TokenVersion AS tokenVersion FROM dbo.AuthUsers ORDER BY Username;
      SELECT UserId AS userId, RoleId AS roleId FROM dbo.AuthUserRoles;`).catch(unavailable)).recordsets as sql.IRecordSet<any>[];
  }
  async roles() {
    return (await (await this.connect()).request().query(`SELECT Id AS id, Name AS name FROM dbo.AuthRoles ORDER BY Name;
      SELECT Id AS id, Name AS name FROM dbo.AuthPermissions ORDER BY Name;
      SELECT RoleId AS roleId, PermissionId AS permissionId FROM dbo.AuthRolePermissions;`).catch(unavailable)).recordsets as sql.IRecordSet<any>[];
  }
  private async mutate(actor: number, action: string, target: string, change: (tx: sql.Transaction) => Promise<unknown>) {
    const tx = new sql.Transaction(await this.connect());
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE).catch(unavailable);
    try {
      const result = await change(tx);
      const admins = await new sql.Request(tx).query(`SELECT TOP(1) u.Id FROM dbo.AuthUsers u JOIN dbo.AuthUserRoles ur ON ur.UserId=u.Id JOIN dbo.AuthRolePermissions rp ON rp.RoleId=ur.RoleId JOIN dbo.AuthPermissions p ON p.Id=rp.PermissionId WHERE u.IsActive=1 AND p.Name='access.manage'`);
      if (!admins.recordset.length) throw new ConflictException('Minimal satu administrator aktif wajib tersedia.');
      await new sql.Request(tx).input('actor', sql.Int, actor).input('action', sql.NVarChar(100), action).input('target', sql.NVarChar(sql.MAX), target)
        .query('INSERT dbo.UserAudit(ActorUserId, Action, Target) VALUES(@actor,@action,@target)');
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      if (error instanceof sql.RequestError && (error.number === 2601 || error.number === 2627)) throw new ConflictException('Username sudah digunakan.');
      if (error instanceof sql.RequestError && error.number === 547) throw new BadRequestException('User, role, atau permission tidak valid.');
      unavailable(error);
    }
  }
  async createUser(actor: number, username: string, displayName: string, password: string, roleIds: number[]) {
    const hash = await passwordHash(password);
    return this.mutate(actor, 'user.create', username, async tx => {
      const result = await new sql.Request(tx).input('username', sql.NVarChar(200), username).input('name', sql.NVarChar(200), displayName).input('hash', sql.VarChar(200), hash)
        .query('INSERT dbo.AuthUsers(Username,DisplayName,PasswordHash) OUTPUT inserted.Id AS id VALUES(@username,@name,@hash)');
      const id = result.recordset[0].id as number;
      await this.assign(tx, 'user', id, roleIds);
      return { id };
    });
  }
  async updateUser(actor: number, id: number, displayName: string, isActive: boolean, password?: string) {
    const hash = password === undefined ? null : await passwordHash(password);
    return this.mutate(actor, 'user.update', String(id), async tx => {
      const result = await new sql.Request(tx).input('id', sql.Int, id).input('name', sql.NVarChar(200), displayName).input('active', sql.Bit, isActive).input('hash', sql.VarChar(200), hash)
        .query('UPDATE dbo.AuthUsers SET DisplayName=@name, IsActive=@active, PasswordHash=COALESCE(@hash,PasswordHash), TokenVersion=TokenVersion+1 WHERE Id=@id');
      if (!result.rowsAffected[0]) throw new NotFoundException('User tidak ditemukan.');
      return { ok: true };
    });
  }
  private async assign(tx: sql.Transaction, kind: 'user' | 'role', id: number, ids: number[]) {
    const table = kind === 'user' ? 'AuthUserRoles' : 'AuthRolePermissions';
    const owner = kind === 'user' ? 'UserId' : 'RoleId';
    const member = kind === 'user' ? 'RoleId' : 'PermissionId';
    const exists = await new sql.Request(tx).input('id', sql.Int, id).query(`SELECT Id FROM dbo.${kind === 'user' ? 'AuthUsers' : 'AuthRoles'} WHERE Id=@id`);
    if (!exists.recordset.length) throw new NotFoundException('User atau role tidak ditemukan.');
    await new sql.Request(tx).input('id', sql.Int, id).query(`DELETE dbo.${table} WHERE ${owner}=@id`);
    for (const value of ids) await new sql.Request(tx).input('id', sql.Int, id).input('value', sql.Int, value).query(`INSERT dbo.${table}(${owner},${member}) VALUES(@id,@value)`);
    if (kind === 'user') await new sql.Request(tx).input('id', sql.Int, id).query('UPDATE dbo.AuthUsers SET TokenVersion=TokenVersion+1 WHERE Id=@id');
    else await new sql.Request(tx).input('id', sql.Int, id).query('UPDATE dbo.AuthUsers SET TokenVersion=TokenVersion+1 WHERE Id IN (SELECT UserId FROM dbo.AuthUserRoles WHERE RoleId=@id)');
  }
  async assignments(actor: number, kind: 'user' | 'role', id: number, ids: number[]) {
    return this.mutate(actor, `${kind}.assign`, String(id), async tx => { await this.assign(tx, kind, id, ids); return { ok: true }; });
  }
}
