// Run: node web/permissions.check.cjs (offline source-contract check).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const api = read('../src/api.ts').replace(/\r\n/g, '\n');
const routes = [...api.matchAll(/@(Get|Post|Put|Delete)\('[^']+'\)/g)];
assert.equal(routes.length, 30);
for (const route of routes) assert.match(api.slice(0, route.index).trimEnd(), /@RequirePermissions\([^\n]*\)$/);
assert.match(api, /@UseInterceptors\(AuthAuditInterceptor\)/);
for (const method of ['Get', 'Post']) assert.ok(api.includes(`@RequirePermissions('transactions.view')\n  @${method}('transactions/loading-location')`));
assert.match(read('Transactions.tsx'), /const canGetLocation = transactionKind\(row\) === 'Kirim' && row\.strStockPileName === null;/);
assert.match(read('App.tsx'), /if \(!profile\) return/);
assert.match(read('App.tsx'), /data\.user \?\? data/);
assert.match(read('permissions.ts'), /createContext<readonly string\[\]>\(\[\]\)/);
for (const code of ['copy_loading', 'generate_receipt', 'pair', 'unpair', 'replay_raw', 'delete', 'restore']) assert.ok(read('Transactions.tsx').includes(`can('transactions.${code}')`));
for (const code of ['update', 'import', 'export', 'delete']) assert.ok(read('CoalCalory.tsx').includes(`can('coal.${code}')`));
console.log('RBAC source contracts passed.');
