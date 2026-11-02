require('reflect-metadata');
const { readFile } = require('node:fs/promises');
const { AuthDbService } = require('../dist/auth-db');
const { PcRegistryService, registryInput } = require('../dist/registry');

async function main() {
  const file = process.argv[2] || process.env.APIS_FILE;
  if (!file || process.argv.length > 3) throw new Error('Usage: node --env-file-if-exists=.env sql/import-api-registry.cjs <apis.json> (or APIS_FILE)');
  const rows = registryInput(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')), true);
  for (const key of ['DB_SERVER', 'AUTH_DB_USER', 'AUTH_DB_PASSWORD']) {
    if (!process.env[key]?.trim()) throw new Error(`Environment ${key} wajib diisi.`);
  }
  if ((process.env.AUTH_DB_DATABASE || 'ITMonitor').toLowerCase() !== 'itmonitor') throw new Error('Import hanya ke ITMonitor.');
  const db = new AuthDbService();
  try { console.log(await new PcRegistryService(db).import(rows)); }
  finally { await db.onModuleDestroy(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
