const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
for (const size of ['1920,1080', '1280,720', '390,844']) test(`BioStar layout and modal ${size}`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'biostar-layout-'));
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    const job = { id: 'fixture', packageId: 'biostar-review-20261103T081043Z-7ccb662c8ec647a497fbd11ebc8cd8d2', target: '192.0.2.1', status: 'READY', revision: 1, createdAt: '2026-11-03T11:13:37.563Z', summary: { userCount: 1, fingerprintCount: 2, cardCount: 0, relationCount: 0, usersWithoutCredential: 0 }, preview: { revision: 1, changedCount: 0, unchangedCount: 1, users: [{ sourceUsrUid: '1006', sourceUsrId: '4', name: 'Operator fixture', targetUsrId: '4', status: 'Tetap', fingerprintCount: 2, csnCount: 0 }] } };
    job.preview.users.push({ sourceUsrUid: '1007', sourceUsrId: '5', name: 'Existing fixture', targetUsrId: '', status: 'Dilewati', reason: 'Nama sama persis sudah ada di server tujuan', fingerprintCount: 1, csnCount: 1 });
    let detailRequests = 0;
    let listRequests = 0;
    window.fetch = async (path, options = {}) => {
      if (options.method && options.method !== 'GET') throw Error('Fixture forbids writes');
      let data;
      if (path === '/auth/me') data = { username: 'fixture', permissions: ['biostar.import'] };
      else if (path === '/biostar/imports') { listRequests++; data = [structuredClone(job)]; }
      else if (path.endsWith('/detail')) { detailRequests++; data = { fingerprints: [{ sourceUsrUid: '1006', fngpIdx: 0 }], cards: [{ sourceCrdUid: '15', crdCsn: 'fixture-card' }], relations: [{ sourceUsrUid: '1006', sourceCrdUid: '15' }] }; }
      else throw Error('Unexpected fixture request: ' + path);
      return { ok: true, json: async () => data };
    };
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 200));
    window.addEventListener('load', async () => { try {
      await tick();
      const page = document.querySelector('.biostar-import-page');
      check(page, 'BioStar page mounted');
      const historyTrigger = page.querySelector('[aria-haspopup="dialog"]');
      check(historyTrigger.textContent === '' && historyTrigger.querySelector('svg') && historyTrigger.getAttribute('aria-label') === 'Riwayat pekerjaan' && historyTrigger.title === 'Riwayat pekerjaan', 'history icon keeps tooltip and accessible name');
      const history = page.querySelector('.biostar-history');
      check(!history.open, 'history hidden by default');
      historyTrigger.focus(); historyTrigger.click(); await tick();
      check(history.matches(':modal'), 'history uses native modal');
      const historyRect = history.getBoundingClientRect();
      check(historyRect.left >= 0 && historyRect.right <= innerWidth, 'history fits viewport');
      history.querySelector('.panel-heading button').click(); await tick();
      check(!history.open && document.activeElement === historyTrigger, 'history close restores focus');
      historyTrigger.click(); await tick();
      [...history.querySelectorAll('button')].find(b => b.textContent === 'Pilih').click();
      await tick();
      check(!history.open, 'select job closes history');
      check(page.textContent.includes('1 user dilewati') && page.textContent.includes('Nama sama persis sudah ada di server tujuan'), 'preview explains skipped destination names');
      for (const theme of ['light', 'dark']) {
        document.documentElement.dataset.theme = theme;
        await tick();
        check(document.documentElement.scrollWidth <= innerWidth, 'no viewport horizontal overflow');
        check(document.documentElement.scrollHeight <= innerHeight, 'page scroll contained in workspace');
        check(page.scrollWidth <= page.clientWidth + 1, 'no page horizontal overflow');
        const cards = [...page.querySelectorAll('.biostar-card')].filter(el => !el.hidden);
        check(Math.abs(page.querySelector('.page-heading').getBoundingClientRect().left - cards[0].getBoundingClientRect().left) <= 1, 'heading aligned with panels');
        for (let i = 1; i < cards.length; i++) check(cards[i].getBoundingClientRect().top - cards[i-1].getBoundingClientRect().bottom >= 12, 'panels have spacing');
        for (const item of page.querySelectorAll('.biostar-meta > div')) check(item.children[1].getBoundingClientRect().top >= item.children[0].getBoundingClientRect().bottom + 4, 'metadata labels separated from values');
        const stats = [...page.querySelector('.biostar-summary').children];
        check(cards.every(card => !/^[0-9]+[.]/.test(card.querySelector('h2').textContent)), 'section titles have no decorative numbering');
        check(getComputedStyle(page.querySelector('.biostar-summary')).display === 'flex', 'summary uses compact wrapping metadata');
        for (const stat of stats) {
          check(stat.getBoundingClientRect().right <= page.getBoundingClientRect().right, 'summary fits panel');
          check(getComputedStyle(stat).backgroundColor === 'rgba(0, 0, 0, 0)', 'summary has no separate tinted cards');
        }
        const trigger = [...page.querySelectorAll('button')].find(b => b.textContent === 'Setujui perubahan ID dan mapping');
        check(trigger, 'single approval action');
        trigger.focus(); trigger.click(); await tick();
        const dialog = page.querySelector('.biostar-confirm');
        check(dialog.matches(':modal'), 'dialog uses native modal top layer');
        const rect = dialog.getBoundingClientRect();
        check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'dialog fits viewport');
        check(Math.abs(rect.top + rect.height / 2 - innerHeight / 2) <= 2, 'dialog centered vertically');
        check(dialog.contains(document.activeElement), 'focus inside modal');
        check(dialog.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24)), 'table cannot cover dialog');
        check(dialog.scrollWidth <= dialog.clientWidth + 1, 'long package ID wraps inside modal');
        dialog.dispatchEvent(new Event('cancel', { cancelable: true })); await tick();
        check(!page.querySelector('.biostar-confirm'), 'cancel closes modal');
        check(document.activeElement === trigger, 'focus returns to trigger');
      }
      const toggle = page.querySelector('[aria-controls="biostar-detail"]');
      toggle.focus(); toggle.click(); await tick();
      const detailModal = document.querySelector('#biostar-detail');
      check(detailModal.matches(':modal') && toggle.getAttribute('aria-haspopup') === 'dialog', 'package detail opens native modal');
      const detailRect = detailModal.getBoundingClientRect();
      check(detailRect.left >= 0 && detailRect.right <= innerWidth && detailRect.top >= 0 && detailRect.bottom <= innerHeight, 'detail modal fits viewport');
      check(detailModal.contains(document.activeElement), 'detail focus stays inside modal');
      const previousListRequests = listRequests;
      const detailTable = document.querySelector('#biostar-detail table');
      check(detailTable.querySelector('th').textContent === 'Nama pemilik', 'fingerprint owner heading');
      check(detailTable.querySelector('tbody td').textContent === 'Operator fixture', 'fingerprint owner matched by source UID');
      const detailTables = document.querySelectorAll('#biostar-detail table');
      check(detailTables.length === 2, 'only fingerprint and card tables displayed');
      check(detailTables[1].querySelector('th').textContent === 'Nama pemilik', 'card owner heading');
      check(detailTables[1].querySelector('tbody td').textContent === 'Operator fixture', 'card owner resolved through user-card relation');
      await new Promise(resolve => setTimeout(resolve, 3200));
      check(listRequests > previousListRequests, 'job polling continues');
      check(detailRequests === 1, 'unchanged job must not reload detail on polling');
      check(document.querySelector('#biostar-detail table') === detailTable, 'detail stays mounted during polling');
      check(!document.querySelector('#biostar-detail').textContent.includes('Memuat detail'), 'no repeated loading message');
      detailModal.querySelector('[aria-label="Tutup detail paket"]').click(); await tick();
      check(!document.querySelector('#biostar-detail') && document.activeElement === toggle, 'closing detail restores trigger focus');
      toggle.click(); await tick();
      document.querySelector('#biostar-detail').dispatchEvent(new Event('cancel', { cancelable: true })); await tick();
      check(!document.querySelector('#biostar-detail'), 'Escape dismisses detail modal');
      document.documentElement.dataset.theme = 'light';
      page.scrollTop = 0;
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
      const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', '--window-size=' + size, '--virtual-time-budget=9000', '--dump-dom', '--user-data-dir=' + profile];
      if (process.env.BIOSTAR_SCREENSHOT_DIR) args.push('--screenshot=' + join(process.env.BIOSTAR_SCREENSHOT_DIR, 'biostar-' + size.replace(',', '-') + '.png'));
      args.push('http://127.0.0.1:' + server.address().port);
      const child = spawn(browser, args, { timeout: 20000 });
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
