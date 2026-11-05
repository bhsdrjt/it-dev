const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const viewer = ['equipment.view', 'coal.view', 'transactions.view', 'monitoring.view', 'timeline.view', 'activity.view'];
const profiles = { viewer, mixed: ['equipment.view', 'equipment.ping', 'coal.view', 'coal.delete', 'transactions.view', 'transactions.copy_loading', 'transactions.restore', 'monitoring.view'], monitoring: ['monitoring.view'], equipment: ['equipment.view'], coal: ['coal.view'], biostar: ['biostar.import'], legacyBiostar: ['biostar.import.view', 'biostar.import.start'], none: [] };
for (const size of ['1280,720', '390,844']) for (const [name, permissions] of Object.entries(profiles)) test(`permission layout ${name} ${size}`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'permission-layout-'));
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    const permissions = ${JSON.stringify(permissions)};
    const check = (ok, label) => { if (!ok) throw Error(label); };
    const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const tick = () => new Promise(resolve => setTimeout(resolve, 150));
    const calls = [];
    window.fetch = async (path, options = {}) => {
      calls.push(path);
      check(!options.method || options.method === 'GET', 'fixture forbids writes');
      let data;
      if (path === '/auth/me') data = { username: 'fixture', permissions };
      else if (path === '/biostar/imports') data = [];
      else if (path === '/apis') data = [{ id: 'one', apiName: 'Fixture API', ipAPI: '127.0.0.1', locationIDs: [7] }];
      else if (path.startsWith('/equipments')) data = [{ EquipmentID: 10, strTruckCN: 'TR-10' }];
      else if (path === '/locations') data = [{ LocationID: 7, strLocationName: 'Fixture location' }];
      else if (path === '/coal-calories') data = [{ CoalQualityAGMID: 1, CoalQualityID: 11, CoalQualityName: 'SEAM FIXTURE', Coalcalory: 5000, dtUpdatedAt: '2026-10-01T08:00:00' }];
      else if (path.startsWith('/anomalies?')) data = { anomalies: [{ id: 'one', code: 'KIRIM_TANPA_PASANGAN_7D', severity: 'critical', category: 'pairing', title: 'Fixture anomaly', detail: 'Fixture detail', cdn: 'FIXTURE', truck: 'TR-10', equipmentId: 10, loadingId: 1, dumpingId: null, eventAt: new Date().toISOString() }], queries: [] };
      else if (path.startsWith('/transactions/truck-history?')) data = { equipmentId: 10, starttime: '2026-10-01T06:00:00', endtime: '2026-10-01T12:00:00', transactions: [], activities: [] };
      else if (path.startsWith('/transactions/timeline?')) data = { coalDeliveryNumber: 'FIXTURE', transactions: ['Kirim', 'Terima', 'Terima'].map((Transaksi, i) => ({ Transaksi, CTFinalTonnageID: i + 1, CoalDeliveryNumber: 'FIXTURE', RefDumpingTonnageID: null, dtLoaded: '2026-10-01T08:00:00', dtEmpty: '2026-10-01T09:00:00', dtTimeCollected: '2026-10-01T08:00:00.000', UserName: 'dispatcher', dtDeletedAt: i === 2 ? '2026-10-02T08:00:00' : null })), activities: [] };
      else throw Error('Unexpected fixture request: ' + path);
      return { ok: true, json: async () => data };
    };
    const layout = () => {
      check(document.documentElement.scrollWidth <= innerWidth, 'viewport horizontal overflow');
      check(document.documentElement.scrollHeight <= innerHeight, 'viewport vertical overflow');
      for (const box of document.querySelectorAll('.panel-toolbar, .page-heading, .topbar, .card-actions')) if (visible(box)) {
        check(box.scrollWidth <= box.clientWidth + 1, 'container clipped: ' + box.className);
      }
      for (const table of document.querySelectorAll('table')) if (visible(table)) {
        const count = [...table.querySelectorAll('thead th')].filter(visible).length;
        for (const row of table.querySelectorAll('tbody tr')) check([...row.children].filter(visible).length === count, 'header/cell alignment');
      }
      for (const box of document.querySelectorAll('.row-actions, .card-actions, .anomaly-route-actions')) if (visible(box)) check([...box.querySelectorAll('button')].some(visible), 'empty action container');
    };
    const open = async text => { const button = [...document.querySelectorAll('.sidebar nav button')].find(node => visible(node) && node.textContent.includes(text)); check(button, 'navigation ' + text); button.click(); await tick(); layout(); };
    window.addEventListener('load', async () => { try {
      await tick(); layout();
      if (permissions.length === 1 && permissions[0] === 'equipment.view') check(calls.slice(1).sort().join('|') === '/apis|/equipments|/locations', 'equipment-only default loads its references');
      if (permissions.length === 1 && permissions[0] === 'coal.view') check(calls.length === 2 && calls[1] === '/coal-calories', 'coal-only default loads coal data');
      if (permissions.includes('monitoring.view')) {
        check(calls.length === 2 && calls[1].startsWith('/anomalies?'), 'only default monitoring fetches at login');
        if (permissions.includes('transactions.view')) {
          document.querySelector('.anomaly-open').click(); await tick();
          document.querySelector('.anomaly-route-transaction').click(); await tick();
          check(document.querySelector('#coal-delivery-number').value === 'FIXTURE', 'first transaction mount receives SK target');
          check(calls.filter(path => path.startsWith('/transactions/timeline?')).length === 1 && document.querySelector('.transaction-summary').textContent.includes('FIXTURE'), 'first monitoring link auto-searches once');
          await open('Monitoring transaksi');
        }
        if (permissions.includes('timeline.view')) {
          document.querySelector('.anomaly-open').click(); await tick();
          document.querySelector('.anomaly-route-timeline').click(); await tick();
          check(document.querySelector('#history-truck').value === 'TR-10 · #10', 'first history mount receives truck target');
          check(calls.filter(path => path === '/equipments?activeOnly=true').length === 1 && calls.filter(path => path.startsWith('/transactions/truck-history?')).length === 1, 'first truck target loads references and automatically searches once');
        }
      }
      const nav = document.querySelector('.sidebar nav');
      check([...nav.querySelectorAll('button')].filter(visible).length === permissions.filter(code => code === 'biostar.import' || (code.endsWith('.view') && !code.startsWith('biostar.'))).length, 'sidebar excludes forbidden pages');
      if (permissions.includes('biostar.import')) {
        check(visible(document.querySelector('.biostar-import-page')), 'unified BioStar permission opens importer');
        check(calls.includes('/biostar/imports'), 'unified permission loads import jobs');
      }
      if (!permissions.length || permissions.includes('biostar.import.view')) {
        check(!visible(nav), 'empty navigation hidden');
        check(document.querySelector('[role="status"]').textContent.includes('Belum ada izin'), 'no-permissions fallback');
        check(calls.length === 1 && calls[0] === '/auth/me', 'no unauthorized reads');
      }
      if (permissions.includes('equipment.view')) {
        await open('Equipment checks');
        const table = document.querySelector('.registry table');
        check([...table.querySelectorAll('th')].filter(visible).length === (permissions.includes('equipment.ping') ? 4 : 3), 'equipment action column');
        check(visible(table.querySelector('.pc-select')), 'PC read selection retained');
      }
      if (permissions.includes('coal.view')) {
        await open('Coal calory');
        const table = document.querySelector('.coal-calory-panel table');
        check([...table.querySelectorAll('th')].filter(visible).length === (permissions.includes('coal.delete') ? 6 : 5), 'coal action column');
        check(table.textContent.includes('SEAM FIXTURE'), 'coal read data retained');
      }
      if (permissions.includes('monitoring.view')) {
        await open('Monitoring transaksi');
        const route = document.querySelector('.anomaly-open');
        check(visible(route) === permissions.includes('transactions.view'), 'monitoring route permission');
        if (visible(route)) { route.click(); await tick(); layout(); document.querySelector('.anomaly-route-modal .panel-heading button').click(); }
      }
      if (permissions.includes('transactions.view')) {
        await open('Analisa transaksi');
        const input = document.querySelector('#coal-delivery-number');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'FIXTURE');
        input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
        input.closest('form').requestSubmit(); await tick(); layout();
        check(document.querySelector('.transaction-timeline'), 'timeline read data retained');
        const trips = document.querySelectorAll('[aria-label="Ritase Kirim / Terima"] > .truck-trip');
        check(trips.length === 3 && [...trips].every(trip => trip.querySelectorAll('.transaction-card').length === 1), 'same SK without reference stays in separate groups, including deleted receipt');
        const receipt = [...document.querySelectorAll('.transaction-card')].find(card => card.querySelector('h3').textContent.trim() === 'Terima');
        const detail = receipt.querySelector('.column-details > summary');
        const titleBounds = receipt.querySelector('.transaction-title').getBoundingClientRect();
        check(Math.abs(detail.getBoundingClientRect().top - titleBounds.top) < 2, 'read-only detail icon shares title row');
        if (innerWidth >= 1000) {
          const badges = receipt.querySelectorAll('.transaction-badges .status');
          check(Math.abs(badges[0].getBoundingClientRect().top - badges[1].getBoundingClientRect().top) < 1, 'read-only dispatcher badge stays beside SK');
          check(receipt.getBoundingClientRect().height < 105, 'read-only card has no empty detail row');
        }
        detail.click(); await tick();
        check(receipt.querySelector('.column-details').open, 'read-only detail expands');
        detail.click(); await tick();
        check(!visible(document.querySelector('[aria-label="Aksi Terima 2"]')), 'copy-only cannot open empty Terima menu');
        check(!visible(document.querySelector('[aria-label="Aksi Terima 3"]')), 'deleted row has no dead dropdown');
        const trigger = document.querySelector('[aria-label="Aksi Kirim 1"]');
        check(visible(trigger) === permissions.includes('transactions.copy_loading'), 'Kirim menu permission');
        if (visible(trigger)) {
          trigger.click(); await tick();
          const menu = document.querySelector('.card-actions-options');
          check([...menu.querySelectorAll('button')].filter(visible).length === 1, 'only allowed copy action');
          const rect = menu.getBoundingClientRect();
          check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'menu not clipped');
        }
      }
      document.body.dataset.testResult = 'passed';
    } catch (error) { document.body.dataset.testResult = 'failed: ' + error.message; } });
  `;
  const server = createServer(async (request, response) => {
    if (request.url === '/app.js' || request.url === '/app.css') {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(await readFile(join(__dirname, '../public', request.url.slice(1))));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script>' + script + '</script><script src="/app.js"></script>');
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', '--window-size=' + size, '--virtual-time-budget=10000', '--dump-dom', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { timeout: 20000 });
      let text = '';
      child.stdout.on('data', data => { text += data; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text) : reject(Error('Browser exited: ' + code)));
    });
    assert.match(output, /data-test-result="passed"/, output.match(/data-test-result="[^"]*"/)?.[0] || 'Browser test did not finish');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
