'use strict';
// node --env-file-if-exists=.env sql/provision-admin.cjs
// Explicit BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD; creates only, never resets users.
const assert = require('node:assert/strict');
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const sql = require('mssql');
const SCRYPT = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
function hash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$16384$8$5$${salt}$${scryptSync(password, salt, 64, SCRYPT).toString('hex')}`;
}
if (process.argv.includes('--self-check')) {
  const value = hash('test-password-123');
  const [, , , , salt, key] = value.split('$');
  assert.match(value, /^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert(timingSafeEqual(scryptSync('test-password-123', salt, 64, SCRYPT), Buffer.from(key, 'hex')));
  assert(!timingSafeEqual(scryptSync('wrong-password', salt, 64, SCRYPT), Buffer.from(key, 'hex')));
  console.log('scrypt self-check passed');
} else {
  void provision().catch(error => { console.error(error.message); process.exitCode = 1; });
}
async function provision() {
  for (const key of ['DB_SERVER', 'AUTH_DB_USER', 'AUTH_DB_PASSWORD', 'BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_PASSWORD']) {
    if (!process.env[key]?.trim()) throw new Error(`${key} required`);
  }
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (username.length > 200 || password.length < 12 || password.length > 1000) throw new Error('Username max 200; password 12–1000 characters');
  const pool = new sql.ConnectionPool({
    server: process.env.DB_SERVER, database: process.env.AUTH_DB_DATABASE || 'ITMonitor',
    user: process.env.AUTH_DB_USER, password: process.env.AUTH_DB_PASSWORD,
    port: Number(process.env.DB_PORT || 1433), connectionTimeout: 5000, requestTimeout: 10000,
    options: { encrypt: process.env.DB_ENCRYPT !== 'false', trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true' },
  });
  let tx;
  try {
    await pool.connect();
    tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const result = await new sql.Request(tx).input('username', sql.NVarChar(200), username).input('hash', sql.VarChar(200), hash(password)).query(`
      IF EXISTS(SELECT 1 FROM dbo.AuthUsers WHERE Username=@username) THROW 50001, 'User already exists; provisioning never resets accounts', 1;
      IF NOT EXISTS(SELECT 1 FROM dbo.AuthRoles r JOIN dbo.AuthRolePermissions rp ON rp.RoleId=r.Id JOIN dbo.AuthPermissions p ON p.Id=rp.PermissionId WHERE r.Name=N'admin' AND p.Name=N'access.manage') THROW 50002, 'Run auth migration first; admin role must have access.manage', 1;
      INSERT dbo.AuthUsers(Username,DisplayName,PasswordHash) VALUES(@username,@username,@hash);
      DECLARE @id int=CONVERT(int,SCOPE_IDENTITY());
      INSERT dbo.AuthUserRoles(UserId,RoleId) SELECT @id,Id FROM dbo.AuthRoles WHERE Name=N'admin';
      INSERT dbo.UserAudit(ActorUserId,Action,Target) VALUES(@id,N'admin.bootstrap',@username);
      SELECT @id AS id;`);
    await tx.commit();
    tx = undefined;
    console.log(`Admin provisioned: ${result.recordset[0].id}`);
  } catch (error) {
    if (tx) await tx.rollback().catch(() => undefined);
    throw error;
  } finally { await pool.close(); }
}
