const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
for (const admin of [false, true]) test(`audit browser admin=${admin}`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'audit-test-'));
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    let calls = 0;
    window.fetch = async path => {
      let data = [];
      if (path === '/auth/me') data = { username: 'fixture', roles: ${JSON.stringify(admin ? ['admin'] : [])}, permissions: ['access.manage'] };
      if (path === '/auth/admin/users') data = { users: [], userRoles: [] };
      if (path === '/auth/admin/roles') data = { roles: [], permissions: [], rolePermissions: [] };
      if (path.startsWith('/auth/admin/audit?')) { calls++; data = { rows: [{ id: '9007199254740993', username: 'operator', displayName: 'Operator', action: 'POST /equipment-checks/upsert', target: JSON.stringify({ apiId: 'PC1', equipmentID: 12, locationID: 7, extra: '<img src=x onerror=alert(1)>', path: '/equipment-checks/upsert' }), createdAt: '2026-01-01T12:00:00Z', outcome: 'succeeded', operationId: 'fixture-operation' }], offset: 0, limit: 50, hasMore: false }; }
      return { ok: true, json: async () => data };
    };
    const check = (ok, text) => { if (!ok) throw Error(text); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 150));
    window.addEventListener('load', async () => { try {
      await tick();
      const menu = [...document.querySelectorAll('nav button')].find(n => /User\\s*Audit/.test(n.textContent));
      check(!!menu === ${admin}, 'role-gated menu');
      if (${admin}) {
        menu.click(); await tick();
        const page = document.querySelector('.audit-page');
        check(page.textContent.includes('fixture-operation'), 'audit loaded');
        check(page.querySelectorAll('tbody tr').length === 1, 'row rendered');
        check([...page.querySelectorAll('th')].map(n => n.textContent).join('|') === 'User|Aktivitas|Target|Hasil|Waktu (lokal)', 'human table columns');
        const cells = page.querySelectorAll('tbody td');
        check(cells[1].firstChild.textContent === 'Kirim konfigurasi equipment', 'human activity');
        check(cells[2].textContent === 'PC: PC1 · Equipment: 12 · Lokasi: 7', 'human target whitelist');
        check(cells[3].textContent === 'Berhasil', 'translated result');
        check(!page.querySelector('details').open, 'technical details initially closed');
        check(!page.querySelector('details code').checkVisibility(), 'raw action hidden');
        page.querySelector('summary').click();
        check(page.querySelector('details').open, 'details expand');
        check(page.querySelector('details').textContent.includes('POST /equipment-checks/upsert'), 'raw action retained');
        check(page.querySelector('details').textContent.includes('fixture-operation'), 'operation retained in details');
        check(page.querySelector('pre').textContent.includes('<img'), 'target text retained');
        check(!page.querySelector('img'), 'target never HTML');
        check(page.scrollWidth <= page.clientWidth + 1, 'page no horizontal overflow');
        check(page.querySelector('.audit-table').scrollWidth > page.querySelector('.audit-table').clientWidth, 'table owns horizontal scroll');
        check([...page.querySelectorAll('button')].find(n => n.textContent === 'Berikutnya').disabled, 'last page disabled');
        [...page.querySelectorAll('button')].find(n => n.textContent === 'Muat ulang').click(); await tick();
        check(calls === 2, 'refresh reads again');
      } else check(calls === 0, 'restricted user never fetches audit');
      document.body.dataset.testResult = 'passed';
    } catch(e) { document.body.dataset.testResult = 'failed: ' + e.message; } });
  `;
  const server = createServer(async (req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(join(__dirname, '../public', req.url.slice(1))));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script>' + script + '</script><script src="/app.js"></script>');
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', '--window-size=390,844', '--virtual-time-budget=10000', '--dump-dom', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { timeout: 20000 });
      let text = ''; child.stdout.on('data', data => { text += data; }); child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text) : reject(Error('Browser exited: ' + code)));
    });
    assert.match(output, /data-test-result="passed"/, output.match(/data-test-result="[^"]*"/)?.[0] || 'Browser test did not finish');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
