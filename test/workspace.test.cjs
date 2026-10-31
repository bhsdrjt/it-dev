const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);

for (const size of ['1280,720', '1440,900', '390,844']) test(`workspace ${size}: truck selection, API sync, navigation and viewport layout`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'workspace-test-'));
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    window.addEventListener('error', event => { document.documentElement.dataset.pageError = String(event.message || event.error); });
    const pcs = [{ id: 'one', apiName: 'API One', ipAPI: '192.0.2.1', locationIDs: [7], online: true }, { id: 'two', apiName: 'API Two', ipAPI: '192.0.2.2', locationIDs: [8], online: true }];
    const calls = [];
    window.confirm = () => { throw Error('Native confirmation must not be used'); };
    let answerConfirmation = () => true;
    let requestDelay = 0;
    let copyStatus = 200;
    let replayFails = false;
    let releaseFails = false;
    let unlinked = false;
    let pairFails = false;
    let pairTimesOut = false;
    window.fetch = async (path, options = {}) => {
      calls.push({ path, body: options.body && JSON.parse(options.body) });
      if (requestDelay) await new Promise(resolve => setTimeout(resolve, requestDelay));
      if (path.startsWith('/anomalies?')) {
        const query = new URL(path, location.origin).searchParams;
        const all = [
          { code: 'KIRIM_LOADING_LOCATION_KOSONG', severity: 'warning', category: 'location', title: 'LoadingLocation Kirim kosong', detail: 'Kirim #88421 (AB260029085) truck TR10040 tidak memiliki LoadingLocation.', cdn: 'AB260029085', truck: 'TR10040', equipmentId: 444, loadingId: 88421, dumpingId: null, eventAt: '2026-10-27T09:01:30' },
          { code: 'KIRIM_TANPA_PASANGAN_7D', severity: 'critical', category: 'pairing', title: 'Kirim tanpa pasangan 7 hari', detail: 'Kirim #88451 (AB260029195) truck TR10061 sudah 9 hari sejak muat tanpa Terima.', cdn: 'AB260029195', truck: 'TR10061', equipmentId: 461, loadingId: 88451, dumpingId: null, eventAt: '2026-10-26T06:55:21' },
        ];
        const rows = all.filter(row =>
          (!query.get('truck') || row.truck.includes(query.get('truck'))) &&
          (!query.get('cdn') || row.cdn.includes(query.get('cdn'))) &&
          (!query.get('severity') || row.severity === query.get('severity')) &&
          (!query.get('category') || row.category === query.get('category')));
        return { ok: true, json: async () => ({ anomalies: rows, queries: ['EXEC dbo.usp_MonitoringAnomali @Mulai = ' + query.get('start') + ', @Selesai = ' + query.get('end')] }) };
      }
      if (path.startsWith('/transactions/truck-history?')) {
        const query = new URL(path, location.origin).searchParams;
        if (query.get('equipmentId') === '12') return { ok: false, status: 503, json: async () => ({ message: 'Database pusat tidak tersedia.' }) };
        const empty = query.get('equipmentId') === '11';
        return { ok: true, json: async () => ({ equipmentId: Number(query.get('equipmentId')), starttime: '2026-04-01T06:00:00.000Z', endtime: '2026-04-02T23:00:00.000Z', transactions: empty ? [] : query.get('equipmentId') === '333' ? Array.from({ length: 101 }, (_, index) => ({ Transaksi: 'Kirim', CTFinalTonnageID: index + 1, CoalDeliveryNumber: 'PAGE-' + (index + 1), dturutan: '2026-04-01T07:00:00.000Z' })) : [{ Transaksi: 'Kirim', CTFinalTonnageID: 71, RefDumpingTonnageID: 77, CoalDeliveryNumber: 'HISTORY-ONLY', dturutan: '2026-04-01T07:00:00.000Z', dtEmpty: '2026-04-01T06:00:00.000Z', dtLoaded: '2026-04-01T07:00:00.000Z', dtDeletedAt: null }, { Transaksi: 'RawTerima', CTFinalTonnageID: 72, dturutan: '2026-04-01T08:00:00.000Z', dtDeletedAt: '2026-04-02T09:00:00.000Z' }], activities: empty ? [] : [{ trans: 'Kirim - Kosong', dtTimeCollected: '2026-04-01T06:00:00.000Z', ReaderLocationName: 'HISTORY READER', flTonnage: 0 }] }) };
      }
      if (path === '/equipments?activeOnly=true') return { ok: true, json: async () => [{ EquipmentID: 10, strTruckCN: 'TR-10' }, { EquipmentID: 11, strTruckCN: 'TR-11' }] };
      if (path.startsWith('/transactions/salin-muatan/candidates?')) {
        const query = new URL(path, location.origin).searchParams;
        if (query.get('nextDT') !== 'TR-11') return { ok: true, json: async () => ({ coalDeliveryNumber: query.get('coalDeliveryNumber'), nextDT: query.get('nextDT'), source: { EquipmentID: 10, dtLoaded: '2026-07-13T13:36:29.000Z' }, candidates: [], preview: { dtEmpty: '2026-07-13T18:00:00.000Z', flEmptyTonnage: 0, dtLoaded: '2026-07-13T17:30:00.000Z', flLoadedTonnage: 32000 } }) };
        return { ok: true, json: async () => ({ coalDeliveryNumber: query.get('coalDeliveryNumber'), nextDT: 'TR-11', source: { EquipmentID: 10, dtLoaded: '2026-07-13T13:36:29.000Z' }, candidates: [{ CTFinalDumpingTonnageID: 55, CoalDeliveryNumber: 'SK-TUJUAN', dtLoaded: '2026-07-13T15:00:00.000Z', dtEmpty: '2026-07-13T16:00:00.000Z' }], preview: null }) };
      }
      if (path === '/transactions/salin-muatan/ke-terima-ada') return { ok: true, json: async () => ({ message: 'Salin muatan ke SK terima berhasil' }) };
      if (path === '/transactions/salin-muatan' && copyStatus !== 200) return { ok: false, status: copyStatus, json: async () => ({ message: copyStatus === 409 ? 'Timbang muat/kosong tujuan yang memenuhi aturan procedure tidak ditemukan.' : 'Hasil Salin Muatan belum dapat dipastikan.' }) };
      if (path === '/transactions/salin-muatan' || path === '/transactions/delete' || path === '/transactions/restore' || path === '/transactions/generate-sk-terima') return { ok: true, json: async () => ({ message: 'Aksi berhasil' }) };
      if (path.startsWith('/transactions/relations?')) {
        const query = new URL(path, location.origin).searchParams;
        if (query.get('dumpingTonnageId') !== '2') throw Error('Wrong relation ID');
        return { ok: true, json: async () => query.get('kind') === 'Kirim'
          ? [{ CTFinalDumpingTonnageID: 2, CoalDeliveryNumber: 'RECEIPT', dtDeletedAt: '2026-07-14T09:10:00.000Z' }]
          : [{ CTFinalLoadingTonnageID: 1, CTFinalDumpingTonnageID: 2, dtDeletedAt: null }, { CTFinalLoadingTonnageID: 9, CTFinalDumpingTonnageID: 2, dtDeletedAt: '2026-07-14T09:10:00.000Z' }] };
      }
      if (path === '/transactions/relations/pair') {
        if (!options.signal) throw Error('Pairing request must have timeout signal');
        if (pairTimesOut) throw new DOMException('Timed out', 'TimeoutError');
        if (!pairFails) unlinked = false;
        return { ok: !pairFails, status: pairFails ? 503 : 201, json: async () => ({ message: pairFails ? 'Hasil belum dapat dipastikan' : 'Kirim berhasil dipasangkan' }) };
      }
      if (path === '/transactions/relations') return { ok: !releaseFails, status: releaseFails ? 503 : 201, json: async () => ({ message: releaseFails ? 'Hasil belum dapat dipastikan' : 'Relasi dilepas' }) };
      if (path === '/transactions/raw-terima') return { ok: !replayFails, status: replayFails ? 503 : 201, json: async () => ({ message: replayFails ? 'Hasil belum dapat dipastikan' : 'RawTerima diproses' }) };
      if (path.startsWith('/transactions/timeline?')) {
        const number = new URL(path, location.origin).searchParams.get('coalDeliveryNumber');
        if (number === 'MISSING') return { ok: false, status: 404, json: async () => ({ message: 'Data tidak ditemukan untuk CoalDeliveryNumber tersebut.' }) };
        return { ok: true, json: async () => ({ coalDeliveryNumber: number, transactions: [
          { Transaksi: 'Kirim', CTFinalTonnageID: 1, RefDumpingTonnageID: unlinked ? null : 2, CoalDeliveryNumber: number, strEquipmentName: 'TR-10', UserName: 'DISPATCHER01', dtEmpty: '2026-07-13T11:56:03.000Z', dtLoaded: '2026-07-13T13:36:29.000Z', dtTimeCollected: '2026-07-13T13:36:29.000Z', IsValid: false, IsAutoReconcile: false, IsManualReconcile: false, strStockPileName: 'PIT TEST', strDumpingLocationName: 'CRUSHER TEST' },
          { Transaksi: 'Terima', CTFinalTonnageID: 2, CoalDeliveryNumber: number, IsValid: false, dtDeletedAt: '2026-07-14T09:10:00.000Z' },
          { Transaksi: 'RawDumping', CTFinalTonnageID: 3, CoalDeliveryNumber: 'OTHER', IsValid: null, dtDeletedAt: '2026-07-14T09:10:00.000Z' },
          { Transaksi: 'RawDumping', CTFinalTonnageID: 4, CoalDeliveryNumber: 'OTHER', dtDeletedAt: null },
        ], activities: [{ trans: 'Net Reader', ReaderLocationName: 'MT TEST', CoalDeliveryNumber: null, flTonnage: 0, dtTimeCollected: '2026-07-13T14:00:00.000Z' }, { trans: 'Tol Gate', ReaderLocationName: 'TOLL TEST', CoalDeliveryNumber: number }] }) };
      }
      const data = path === '/apis' ? pcs : path === '/equipments' ? [{ EquipmentID: 10, strTruckCN: 'TR-10' }, { EquipmentID: 11, strTruckCN: 'TR-11' }, { EquipmentID: 99, strTruckCN: 'DELETED' }] : path === '/locations' ? [7, 8].map(id => ({ LocationID: id, strLocationName: 'Lokasi ' + id })) : path.startsWith('/equipment-checks/location?') ? { locationID: path.includes('apiId=two') ? 8 : 7, locationName: 'Lokasi ditemukan', checkedLocationIDs: [7], message: 'Lookup selesai' } : path === '/equipment-checks/upsert' ? { message: 'Tersimpan' } : path === '/coal-calories' ? [
        { CoalQualityAGMID: 1, CoalQualityID: 11, CoalQualityName: 'SEAM B', Coalcalory: 5000, dtUpdatedAt: '2026-10-01T08:00:00.000Z' },
        { CoalQualityAGMID: 2, CoalQualityID: 12, CoalQualityName: 'SEAM A', Coalcalory: null, dtUpdatedAt: '2026-10-02T08:00:00.000Z' },
        { CoalQualityAGMID: 3, CoalQualityID: 13, CoalQualityName: 'SEAM C', Coalcalory: 6300, dtUpdatedAt: '2026-10-03T08:00:00.000Z' },
      ] : [];
      return { ok: true, json: async () => data };
    };
    const check = (value, label) => { if (!value) throw Error(label); };
    const tick = async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      const modal = document.querySelector('.confirm-modal[open]');
      if (modal) {
        check(document.activeElement.textContent === 'Batal', 'confirmation defaults to safe cancel action');
        check(modal.getBoundingClientRect().width <= innerWidth && modal.scrollHeight >= modal.clientHeight, 'confirmation fits viewport and remains scrollable');
        const accepted = answerConfirmation(modal.querySelector('#confirm-message').textContent);
        modal.querySelector(accepted ? '.primary' : '.confirm-actions button').click();
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    };
    const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text));
    const checkIcon = node => {
      check(node && !node.textContent.trim() && node.querySelector('svg[aria-hidden="true"]'), 'action uses decorative icon without visible text');
      check(node.title && node.getAttribute('aria-label'), 'icon retains tooltip and accessible name');
      const rect = node.getBoundingClientRect();
      check(rect.width >= 24 && rect.width <= 36 && rect.height >= 24, 'icon button stays compact with accessible target');
    };
    const change = (element, value) => {
      const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    const pickDate = async (inputId, day) => {
      document.querySelector('#' + inputId).click(); await tick();
      for (let i = 0; i < 24; i++) {
        const head = document.querySelector('.date-popup-head strong');
        if (head && head.textContent === 'April 2026') break;
        const prev = document.querySelector('.date-popup-head button[aria-label="Bulan sebelumnya"]');
        if (!prev) break;
        prev.click(); await tick();
      }
      const cell = [...document.querySelectorAll('.date-popup-grid button')].find(b => b.textContent.trim() === String(day));
      check(cell, 'date cell ' + day + ' for ' + inputId);
      cell.click(); await tick();
    };
    const waitFor = (cond, label, timeout = 5000) => new Promise((resolve, reject) => {
      let lastErr;
      const iv = setInterval(() => {
        try { if (cond()) { clearInterval(iv); resolve(); } } catch (e) { lastErr = e; }
      }, 50);
      setTimeout(() => { clearInterval(iv); reject(lastErr || Error(label || 'timeout')); }, timeout);
    });
    window.addEventListener('load', async () => {
      try {
        await tick();
        check(document.querySelector('.workspace'), 'workspace mounted');
        const themeToggle = document.querySelector('[aria-label="Mode gelap"]');
        const checkTopbarButtons = () => {
          const themeBox = themeToggle.getBoundingClientRect();
          const logoutBox = document.querySelector('[aria-label="Keluar"]').getBoundingClientRect();
          check(themeBox.width === 36 && themeBox.height === 36 && logoutBox.width === 36 && logoutBox.height === 36 && themeBox.top === logoutBox.top, 'theme and logout buttons align at exactly 36 by 36 pixels');
        };
        checkTopbarButtons();
        if (themeToggle.getAttribute('aria-pressed') === 'true') { themeToggle.click(); await tick(); }
        themeToggle.click(); await tick();
        check(document.documentElement.dataset.theme === 'dark' && localStorage.getItem('theme') === 'dark' && themeToggle.getAttribute('aria-pressed') === 'true', 'dark theme enabled and saved');
        checkTopbarButtons();
        check(getComputedStyle(document.querySelector('.panel')).backgroundColor === 'rgb(26, 33, 41)' && getComputedStyle(document.documentElement).colorScheme === 'dark', 'dark surfaces and native controls themed');
        themeToggle.click(); await tick();
        check(document.documentElement.dataset.theme === 'light' && localStorage.getItem('theme') === 'light', 'light theme restored and saved');
        check(getComputedStyle(document.querySelector('.sidebar')).backgroundColor === 'rgb(186, 230, 253)' && getComputedStyle(document.querySelector('.primary')).backgroundColor === 'rgb(125, 211, 252)', 'light theme uses sky blue sidebar and primary buttons, not navy');
        check(getComputedStyle(document.querySelector('[aria-label="Keluar"]')).color !== 'rgb(229, 233, 238)' && getComputedStyle(document.querySelector('[aria-label="Keluar"]')).color !== 'rgb(255, 255, 255)', 'logout icon color stays visible on light topbar');
        const truck = document.querySelector('#truck-picker');
        const pc = document.querySelector('.configuration select');
        check(document.querySelectorAll('.configuration select').length === 2, 'no duplicate equipment dropdown');
        change(truck, 'TR-10 · #10'); await tick();
        check(document.querySelector('#truck-selection').textContent.includes('#10'), 'truck resolves equipment ID');
        change(pc, 'one'); await tick();
        check(document.querySelector('.configuration select:last-of-type'), 'configuration available');
        check(calls.some(row => row.path.includes('apiId=one&equipmentId=10')), 'lookup uses selected truck');
        change(pc, 'two'); await tick();
        check(truck.value === 'TR-10 · #10', 'truck stays selected across APIs');
        check(calls.some(row => row.path.includes('apiId=two&equipmentId=10')), 'lookup follows changed API');
        check(!button('Kirim konfigurasi').disabled, 'configuration ready');
        button('Kirim konfigurasi').click(); await tick();
        const sent = calls.find(row => row.path === '/equipment-checks/upsert');
        check(sent.body.equipmentID === 10 && sent.body.apiId === 'two' && sent.body.locationID === 8, 'upsert shares truck and API selection');
        change(truck, 'unknown'); await tick();
        check(button('Kirim konfigurasi').disabled, 'invalid truck cannot reuse stale ID');
        change(truck, '11'); await tick();
        check(document.querySelector('#truck-selection').textContent.includes('#11'), 'ID input resolves truck');
        change(truck, ''); await tick();
        check(button('Kirim konfigurasi').disabled, 'cleared truck disables send');
        check(!button('Data equipment checks') && !document.querySelector('.checks-panel'), 'data menu and panel removed');
        check(!calls.some(row => row.path.startsWith('/equipment-checks?')), 'removed panel makes no data requests');
        check(!document.querySelector('#root').textContent.includes('PC'), 'UI labels use API');
        check(document.querySelector('.registry:not(.coal-calory-panel) .location-tags').textContent === 'Lokasi 7', 'registry displays strLocationName');
        const search = document.querySelector('.registry:not(.coal-calory-panel) input[type="search"]');
        change(search, 'Lokasi 8'); await tick();
        check(document.querySelectorAll('.registry:not(.coal-calory-panel) tbody tr').length === 1 && document.querySelector('.registry:not(.coal-calory-panel) tbody').textContent.includes('API Two'), 'registry filters by location name');
        change(search, ''); await tick();
        button('Activity log').click(); await tick();
        check(!document.querySelector('.activity-page').hidden && document.querySelector('.equipment-page:not(.activity-page)').hidden, 'activity opens standalone page');
        check(!document.querySelector('.equipment-page:not(.activity-page) .activity') && document.querySelector('.sidebar [aria-current="page"]').textContent.includes('Activity log'), 'global log removed from equipment and available in sidebar');
        check(document.querySelector('[role="log"]').textContent.includes('Lookup') && document.querySelector('.topbar-context').textContent.includes('Activity log'), 'global log retains session entries and page context');
        button('Analisa transaksi').click(); await tick();
        check(!document.querySelector('.transactions-page').hidden, 'transaction menu opens');
        check(document.querySelector('.sidebar [aria-current="page"]').textContent.includes('Analisa transaksi'), 'active menu announced');
        const cdn = document.querySelector('#coal-delivery-number');
        cdn.focus(); await tick();
        check(cdn.matches(':focus-visible'), 'CDN field has visible focus');
        const focusStyle = getComputedStyle(cdn);
        check(parseFloat(focusStyle.outlineWidth) >= 2 && parseFloat(focusStyle.outlineOffset) <= -parseFloat(focusStyle.outlineWidth), 'CDN focus ring stays inside field without clipping');
        change(cdn, 'AF260080419'); await tick();
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        check(document.querySelector('.transaction-summary').textContent.includes('AF260080419'), 'CDN results loaded');
        check(document.querySelector('.transaction-timeline').textContent.includes('2026-07-13 13:36:29.000'), 'database time not shifted');
        check(document.querySelector('.transaction-timeline h3').textContent.trim() === 'Kirim', 'ID is not placed in card title');
        check(document.querySelector('.transaction-timeline .transaction-meta').textContent.includes('ID 1'), 'Kirim card exposes CTFinalTonnageID without opening detail');
        const terimaCard = [...document.querySelectorAll('.transaction-timeline article')].find(node => node.querySelector('h3').textContent.trim() === 'Terima');
        check(terimaCard.querySelector('.transaction-meta').textContent.includes('ID 2'), 'Terima card exposes its ID too');
        const firstCard = document.querySelector('.transaction-timeline article');
        const details = firstCard.querySelector('.transaction-details');
        const detailToggle = details.querySelector('summary');
        const actionToggle = firstCard.querySelector('.card-actions > button');
        check(detailToggle.getAttribute('aria-label') === 'Detail seluruh kolom' && !detailToggle.textContent.trim() && detailToggle.querySelector('svg'), 'detail toggle is labeled icon only');
        const detailRect = detailToggle.getBoundingClientRect(), detailActionRect = actionToggle.getBoundingClientRect();
        check(Math.abs(detailRect.right - detailActionRect.right) < 1 && detailRect.top >= detailActionRect.bottom && detailRect.top - detailActionRect.bottom <= 6, 'detail icon sits directly below action menu');
        check(detailRect.width === detailActionRect.width && getComputedStyle(detailToggle).borderTopWidth === '1px', 'detail icon matches action button size and border');
        detailToggle.click(); await tick();
        check(details.open && details.querySelector('dl').getBoundingClientRect().height > 0, 'detail icon expands columns');
        detailToggle.click(); await tick();
        check(!details.open, 'detail icon collapses columns');
        for (const key of ['strStockPileName', 'strDumpingLocationName', 'IsValid', 'IsAutoReconcile', 'IsManualReconcile']) check([...details.querySelectorAll('dt')].some(node => node.textContent.trim() === key), 'removed summary field retained in details: ' + key);
        const summary = firstCard.cloneNode(true);
        summary.querySelector('.transaction-details').remove();
        check(!/PIT TEST|CRUSHER TEST|IsValid|Auto reconcile|Manual reconcile/.test(summary.textContent), 'extra fields hidden outside details');
        check([...details.querySelectorAll('dt')].find(node => node.textContent.trim() === 'IsValid').nextElementSibling.textContent.trim() === 'false', 'false value retained in details');
        const badges = firstCard.querySelectorAll('.transaction-badges .status');
        check(badges.length === 2 && badges[0].textContent.includes('SK dicari') && badges[1].textContent.includes('created by dispatcher : DISPATCHER01'), 'dispatcher marker directly below searched SK badge with UserName');
        check(badges[1].getBoundingClientRect().top >= badges[0].getBoundingClientRect().bottom, 'dispatcher badges stack vertically');
        check(document.querySelectorAll('.transaction-timeline .deleted-record').length === 1, 'only non-null deletion date marked');
        check(document.querySelector('.transaction-timeline .deleted-status').textContent.includes('Sudah dihapus') && document.querySelector('.transaction-timeline .deleted-status').textContent.includes('2026-07-14 09:10:00.000'), 'deleted transaction shows status and date');
        const card = document.querySelector('.transaction-timeline article');
        check(parseFloat(getComputedStyle(card).paddingTop) <= 8, 'transaction card uses compact padding');
        if (innerWidth >= 1000) check(card.getBoundingClientRect().height < 165, 'desktop transaction card stays compact');
        check(!document.querySelector('.transaction-notice'), 'window notice removed');
        check(!document.querySelector('.transaction-workspace .eyebrow') && !button('Kembali ke equipment checks'), 'extra heading and back button removed');
        check(!document.querySelector('.transaction-workspace').textContent.includes('Kirim, Terima, TerimaRaw, dan aktivitas reader berdasarkan CoalDeliveryNumber.'), 'heading description removed');
        for (const [kind, id, count] of [['Kirim', 1, 1], ['Terima', 2, 2]]) {
          const inspect = document.querySelector('button[aria-label="Cek relasi ' + kind + ' ' + id + '"]');
          checkIcon(inspect);
          inspect.focus(); inspect.click(); await tick();
          const modal = document.querySelector('.relation-modal');
          check(modal.open && modal.querySelector('h2').textContent.includes(kind + ' #' + id), 'relation modal opens with source ID');
          check(modal.querySelectorAll('tbody tr').length === count, 'relation table shows all matching rows');
          check(modal.querySelector('.deleted-record .deleted-status').textContent.includes('Sudah dihapus'), 'deleted relation marked');
          check(modal.getBoundingClientRect().width <= innerWidth, 'modal fits viewport');
          if (kind === 'Kirim') modal.querySelector('button').click();
          else modal.dispatchEvent(new Event('cancel', { cancelable: true }));
          await tick();
          check(!document.querySelector('.relation-modal'), 'close and Escape dismiss relation modal');
          check(document.activeElement === inspect, 'modal restores trigger focus');
        }
        const releaseButton = () => document.querySelector('button[aria-label="Lepas relasi Kirim 1 dari Terima 2"]');
        check(releaseButton(), 'release button shown for linked Kirim');
        checkIcon(releaseButton());
        check(releaseButton().getBoundingClientRect().width === 26, 'relation button reduced to 26px');
        check(releaseButton().parentElement.classList.contains('transaction-meta'), 'relation button aligned as metadata sibling');
        if (innerWidth >= 1000) {
          const meta = firstCard.querySelector('.transaction-meta');
          const center = node => { const r = node.getBoundingClientRect(); return r.top + r.height / 2; };
          check([...meta.children].every(node => Math.abs(center(node) - center(releaseButton())) < 2), 'CDN ID reference and button share one aligned row');
        }
        check(!document.querySelector('button[aria-label*="Lepas relasi Kirim 2"]'), 'unlinked Kirim has no release button');
        answerConfirmation = () => false;
        releaseButton().click(); await tick();
        check(!calls.some(row => row.path === '/transactions/relations'), 'cancel release does not write');
        answerConfirmation = message => { check(message.includes('Kirim #1') && message.includes('Terima #2') && message.includes('NULL'), 'release confirmation identifies relation'); return true; };
        const readsBeforeRelease = calls.filter(row => row.path.startsWith('/transactions/timeline?')).length;
        releaseButton().click(); await tick();
        const releases = calls.filter(row => row.path === '/transactions/relations');
        check(releases.length === 1 && releases[0].body.loadingTonnageId === 1 && releases[0].body.confirmed === true, 'release sends Kirim ID and confirmation');
        check(calls.filter(row => row.path.startsWith('/transactions/timeline?')).length === readsBeforeRelease + 1, 'release refreshes timeline');
        check(document.querySelector('.transaction-workspace [role="status"]').textContent.includes('Relasi dilepas'), 'release success announced');
        releaseFails = true;
        releaseButton().click(); await tick();
        check(releaseButton().disabled, 'uncertain release blocks retry until reload');
        check(document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('Muat ulang'), 'uncertain release asks for reload');
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        check(!releaseButton().disabled, 'fresh read unlocks release');
        button('TerimaRaw').click(); await tick();
        check(document.querySelector('.transaction-results table').textContent.includes('OTHER'), 'raw data from other CDN retained');
        check(document.querySelector('.transaction-results tr.deleted-record .deleted-status').textContent.includes('Sudah dihapus'), 'deleted raw row remains visible and marked');
        check(document.querySelector('.transaction-results tbody tr').className !== 'selected-row', 'other CDN not highlighted');
        check(document.querySelector('.transaction-results tr.deleted-record button').disabled, 'deleted raw cannot replay');
        const replayButton = () => document.querySelector('button[aria-label="Masukkan RawTerima 4 ke Terima"]');
        checkIcon(replayButton());
        answerConfirmation = () => false;
        replayButton().click(); await tick();
        check(!calls.some(row => row.path === '/transactions/raw-terima'), 'cancel confirmation does not write');
        answerConfirmation = message => { check(message.includes('RawTerima #4') && message.includes('usp_DebugCTFinalDumpingTonnagebyID') && message.includes('menandai transaksi lama dihapus'), 'confirmation identifies row CDN and side effects'); return true; };
        const readsBeforeReplay = calls.filter(row => row.path.startsWith('/transactions/timeline?')).length;
        replayButton().click(); replayButton().click(); await tick();
        const replays = calls.filter(row => row.path === '/transactions/raw-terima');
        check(replays.length === 1 && replays[0].body.rawTonnageId === 4 && !('coalDeliveryNumber' in replays[0].body) && replays[0].body.confirmed === true, 'single replay uses raw row ID, not CDN');
        check(calls.filter(row => row.path.startsWith('/transactions/timeline?')).length === readsBeforeReplay + 1, 'successful replay refreshes timeline');
        check(document.querySelector('.transaction-workspace [role="status"]').textContent.includes('RawTerima diproses'), 'success is announced');
        replayFails = true;
        replayButton().click(); await tick();
        check(replayButton().disabled, 'uncertain replay blocks retry until reload');
        check(document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('Muat ulang'), 'uncertain outcome asks for reload');
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        button('TerimaRaw').click(); await tick();
        check(!replayButton().disabled, 'fresh read unlocks replay');
        button('Aktivitas truck').click(); await tick();
        const activityTrips = document.querySelectorAll('.truck-trip');
        check(activityTrips.length === 2 && document.querySelector('.truck-trips').textContent.includes('MT TEST') && document.querySelector('.truck-trips').textContent.includes('Tol Gate'), 'reader activity grouped into trip cards');
        check([...activityTrips].every(node => node.querySelector('.trip-heading h3').textContent.includes('Ritase')), 'each activity group labels its ritase');
        check([...document.querySelectorAll('.activity-card')].some(node => node.querySelector('.status')?.textContent === 'SK dicari'), 'searched SK badge retained in activity groups');
        const highlightedActivity = document.querySelector('.truck-trip li.trip-highlight article');
        const plainActivity = document.querySelector('.activity-card');
        check(highlightedActivity && getComputedStyle(highlightedActivity).backgroundColor !== getComputedStyle(plainActivity).backgroundColor, 'searched activity uses a distinct subtle tint');
        const activityCard = document.querySelector('.activity-card');
        const activityDetailToggle = activityCard.querySelector('.column-details > summary');
        const activityCardRect = activityCard.getBoundingClientRect(), activityDetailRect = activityDetailToggle.getBoundingClientRect();
        check(!activityCard.querySelector('.card-actions') && Math.abs(activityCardRect.right - activityDetailRect.right - 7) < 1 && Math.abs(activityDetailRect.top - activityCardRect.top - 5) < 1, 'activity detail icon stays at card top right without action menu');
        activityDetailToggle.click(); await tick();
        check(activityCard.querySelector('.column-details').open, 'activity detail still expands');
        activityDetailToggle.click(); await tick();
        check(document.querySelector('.truck-trips').textContent.includes('SK belum tercatat'), 'null SK not attributed to target');
        check(document.documentElement.scrollHeight <= innerHeight, 'transaction results fit viewport');
        button('Analisa anomali').click(); await tick();
        check(document.querySelector('.anomaly-content').textContent.includes('RefDumpingTonnageID'), 'anomaly tab explains reference join');
        check(document.querySelector('.target-pair').textContent.includes('#2') && document.querySelector('.target-pair').textContent.includes('Terima sudah dihapus'), 'reference pairing rendered');
        check(document.querySelectorAll('.stage-counts li').length === 6, 'six expected journey stages shown');
        check(document.querySelector('.anomaly-content').textContent.includes('kelengkapan belum terverifikasi'), 'missing activity qualified against incomplete results');
        check(document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth, 'anomaly tab fits viewport');
        check(!document.querySelector('button[aria-label="Pasangkan Terima untuk Kirim 1"]'), 'linked Kirim cannot pair again');
        unlinked = true;
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        const pairButton = () => document.querySelector('button[aria-label="Pasangkan Terima untuk Kirim 1"]');
        check(pairButton(), 'pair button shown on unlinked Kirim timeline');
        checkIcon(pairButton());
        button('Analisa anomali').click(); await tick();
        check(pairButton(), 'pair button shown in analysis');
        answerConfirmation = () => false;
        pairButton().click(); await tick();
        check(!calls.some(row => row.path === '/transactions/relations/pair'), 'cancel pairing does not write');
        answerConfirmation = message => { check(message.includes('Kirim #1') && message.includes('dtEmpty paling awal') && message.includes('Trigger'), 'pairing confirmation describes selection and side effects'); return true; };
        const readsBeforePair = calls.filter(row => row.path.startsWith('/transactions/timeline?')).length;
        pairButton().click(); pairButton().click(); await tick();
        const pairs = calls.filter(row => row.path === '/transactions/relations/pair');
        check(pairs.length === 1 && pairs[0].body.loadingTonnageId === 1 && pairs[0].body.confirmed === true, 'pairing sends exact Kirim ID once');
        check(calls.filter(row => row.path.startsWith('/transactions/timeline?')).length === readsBeforePair + 1, 'pairing refreshes timeline');
        check(!pairButton() && releaseButton(), 'paired Kirim switches to release button');
        check(document.querySelector('.transaction-workspace [role="status"]').textContent.includes('berhasil dipasangkan'), 'pairing success announced');
        unlinked = true; pairFails = true;
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        pairButton().click(); await tick();
        check(pairButton().disabled, 'uncertain pairing blocks retry');
        check(document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('Muat ulang'), 'uncertain pairing asks for reload');
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        check(!pairButton().disabled, 'fresh read unlocks pairing');
        pairTimesOut = true;
        pairButton().click(); await tick();
        check(document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('Status perubahan belum diketahui'), 'timeout reports uncertain result');
        check(!cdn.disabled && !document.querySelector('.transaction-search button').disabled, 'timeout releases busy state so operator can reload');
        check(pairButton().disabled, 'timeout blocks writes until fresh read');
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        check(!document.querySelector('.transaction-search').textContent.includes('Salin Muatan'), 'copy removed from search');
        const cardAction = () => document.querySelector('button[aria-label="Aksi Kirim 1"]');
        checkIcon(cardAction());
        const actionRect = cardAction().getBoundingClientRect();
        const cardRect = cardAction().closest('article').getBoundingClientRect();
        check(cardRect.right - actionRect.right <= 10 && actionRect.top - cardRect.top <= 10, 'action icon at card top right');
        check(document.querySelector('button[aria-label="Aksi Terima 2"]').disabled, 'deleted receipt actions disabled');
        const actionRoot = cardAction().parentElement;
        actionRoot.style.cssText = 'position:fixed;top:auto;bottom:20px;right:20px';
        cardAction().focus(); cardAction().click(); await tick();
        const menu = document.querySelector('.card-actions-options');
        check(menu.matches(':popover-open'), 'action menu escapes timeline clipping through top layer');
        const menuRect = menu.getBoundingClientRect();
        check(menuRect.bottom <= cardAction().getBoundingClientRect().top, 'menu flips above trigger near viewport bottom');
        check(menuRect.top >= 0 && menuRect.left >= 0 && menuRect.right <= innerWidth && menuRect.bottom <= innerHeight, 'all actions stay inside viewport');
        const deleteRect = menu.querySelector('.danger').getBoundingClientRect();
        check(menu.contains(document.elementFromPoint(deleteRect.left + deleteRect.width / 2, deleteRect.top + deleteRect.height / 2)), 'last action visible and clickable outside scroll container');
        cardAction().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
        check(!document.querySelector('.card-actions-options') && document.activeElement === cardAction(), 'Escape closes menu and returns focus');
        actionRoot.removeAttribute('style');
        cardAction().click(); await tick();
        document.querySelector('.transaction-timeline').dispatchEvent(new Event('scroll')); await tick();
        check(!document.querySelector('.card-actions-options'), 'scroll closes menu instead of leaving detached actions');
        cardAction().click(); await tick();
        button('Salin Muatan').click(); await tick();
        check(document.querySelector('.salin-modal[open]'), 'copy modal opens without crash');
        check(document.querySelector('#salin-cdn').readOnly && document.querySelector('#salin-cdn').value === 'AF260080419', 'card CDN locked');
        check(calls.some(row => row.path === '/equipments?activeOnly=true'), 'truck search requests active equipment');
        check([...document.querySelectorAll('.salin-modal .combobox-options [role="option"]')].some(node => node.textContent === 'TR-11'), 'active equipment options loaded');
        check(getComputedStyle(document.querySelector('.salin-modal')).overflow === 'visible', 'truck options render uncut inside copy modal');
        change(document.querySelector('#salin-truck'), 'TR-11'); await tick();
        check(calls.some(row => row.path.startsWith('/transactions/salin-muatan/candidates?') && row.path.includes('nextDT=TR-11')), 'receipt candidates fetched for target truck');
        let statusText = '';
        for (let i = 0; i < 60; i++) {
          const el = document.querySelector('.salin-modal [role="status"]');
          if (el && el.textContent.includes('SK terima #55')) { statusText = el.textContent; break; }
          await tick();
        }
        check(statusText.includes('SK terima #55'), 'existing receipt announced without picker');
        check(!document.querySelector('#salin-sk') && !document.querySelector('#salin-with-sk'), 'no receipt picker and no checkbox');
        check(!button('Salin muatan').disabled, 'copy enabled once receipt check completes');
        answerConfirmation = message => { check(message.includes('Terima #55') && message.includes('usp_SalinMuatanKeTerimaAda'), 'receipt copy confirmation names Terima and procedure'); return true; };
        document.querySelector('.salin-modal form').requestSubmit(); await tick();
        const keTerima = calls.filter(row => row.path === '/transactions/salin-muatan/ke-terima-ada');
        check(keTerima.length === 1 && keTerima[0].body.ctFinalDumpingTonnageId === 55 && keTerima[0].body.nextDT === 'TR-11' && keTerima[0].body.confirmed === true, 'receipt copy sends chosen Terima ID once');
        check(!calls.some(row => row.path === '/transactions/salin-muatan'), 'receipt copy does not call the plain procedure');
        check(!document.querySelector('.salin-modal'), 'successful receipt copy closes modal');
        const writes = () => calls.filter(row => row.path === '/transactions/salin-muatan' || row.path === '/transactions/salin-muatan/ke-terima-ada').length;
        cardAction().click(); await tick();
        button('Salin Muatan').click(); await tick();
        change(document.querySelector('#salin-truck'), 'TR-11'); await tick();
        answerConfirmation = () => false;
        const writesBeforeCancel = writes();
        document.querySelector('.salin-modal form').requestSubmit(); await tick();
        check(writes() === writesBeforeCancel, 'copy cancellation makes no write');
        change(document.querySelector('#salin-truck'), 'TR-10'); await tick();
        check(document.querySelector('.salin-modal [role="status"]').textContent.includes('Tidak ada SK terima'), 'missing receipt announced');
        check(document.querySelector('.salin-modal [role="status"]').textContent.includes('2026-07-13 18:00:00'), 'preview shows receipt empty time to be created');
        check(document.querySelector('.salin-modal [role="status"]').textContent.includes('2026-07-13 17:30:00'), 'preview shows receipt loaded time to be created');
        answerConfirmation = message => { check(message.includes('usp_SalinMuatan') && !message.includes('usp_SalinMuatanKeTerimaAda'), 'fallback confirmation names plain procedure'); return true; };
        document.querySelector('.salin-modal form').requestSubmit();
        document.querySelector('.salin-modal form').requestSubmit(); await tick();
        const copies = calls.filter(row => row.path === '/transactions/salin-muatan');
        check(copies.length === 1 && copies[0].body.nextDT === 'TR-10' && copies[0].body.coalDeliveryNumber === 'AF260080419', 'copy sends card CDN and truck once');
        check(!document.querySelector('.salin-modal'), 'successful copy closes modal');
        for (const status of [409, 503]) {
          copyStatus = status;
          cardAction().click(); await tick();
          button('Salin Muatan').click(); await tick();
          change(document.querySelector('#salin-truck'), 'TR-10'); await tick();
          const reads = calls.filter(row => row.path.startsWith('/transactions/timeline?')).length;
          document.querySelector('.salin-modal form').requestSubmit(); await tick();
          check(!document.querySelector('.salin-modal') && !document.querySelector('.confirm-modal'), 'failed copy releases modal focus');
          check(cardAction().disabled === (status === 503), 'only uncertain copy result blocks mutations');
          if (status === 409) {
            check(calls.filter(row => row.path.startsWith('/transactions/timeline?')).length === reads && !document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('Muat ulang'), 'rejected copy unlocks without reload');
          }
          const actionLocked = cardAction().disabled;
          const callsBeforeDismiss = calls.length;
          document.querySelector('.transaction-workspace [aria-label="Tutup notifikasi"]').click(); await tick();
          check(!document.querySelector('.transaction-workspace [role="alert"]') && calls.length === callsBeforeDismiss, 'close button dismisses error without request');
          check(cardAction().disabled === actionLocked && document.querySelector('.transaction-timeline'), 'dismiss preserves timeline and mutation safety lock');
          if (status === 503) { document.querySelector('.transaction-search').requestSubmit(); await tick(); }
        }
        copyStatus = 200;
        cardAction().click(); await tick();
        answerConfirmation = () => true;
        const skOption = () => [...document.querySelectorAll('.card-actions-options button')].find(node => node.textContent === 'Generate SK Terima');
        check(skOption(), 'generate SK Terima appears in Kirim card actions');
        skOption().click(); await tick();
        const generated = calls.filter(row => row.path === '/transactions/generate-sk-terima');
        check(generated.length === 1 && generated[0].body.coalDeliveryNumber === 'AF260080419' && generated[0].body.confirmed === true, 'generate SK sends card CDN once');
        check(!document.querySelector('.card-actions-options'), 'action menu closes after generate');
        cardAction().click(); await tick();
        answerConfirmation = () => false;
        document.querySelector('.card-actions-options .danger').click(); await tick();
        check(!calls.some(row => row.path === '/transactions/delete'), 'delete cancellation makes no write');
        cardAction().click(); await tick();
        answerConfirmation = () => true;
        document.querySelector('.card-actions-options .danger').click(); await tick();
        const deletion = calls.find(row => row.path === '/transactions/delete');
        check(deletion.body.kind === 'Kirim' && deletion.body.tonnageId === 1 && deletion.body.confirmed, 'delete sends selected kind and ID');
        change(cdn, 'MISSING'); await tick();
        document.querySelector('.transaction-search').requestSubmit(); await tick();
        check(document.querySelector('.transaction-workspace [role="alert"]').textContent.includes('tidak ditemukan'), 'not found shown');
        check(!document.querySelector('.transaction-results'), 'old results cleared after failure');
        button('Timeline truck').click(); await tick();
        let history = document.querySelector('.truck-history');
        check(calls.some(row => row.path === '/equipments?activeOnly=true') && !history.querySelector('.combobox-options').textContent.includes('DELETED'), 'truck history loads only active equipment');
        check(!history.parentElement.hidden && document.querySelector('.sidebar [aria-current="page"]').textContent.includes('Timeline truck'), 'truck history navigation opens');
        check(!calls.some(row => row.path.startsWith('/transactions/truck-history?')), 'history does not query before submit');
        change(document.querySelector('#history-truck'), 'TR-10 · #10');
        await pickDate('history-start', 1);
        await pickDate('history-end', 2);
        const startSel = document.querySelector('#history-start-time select');
        const endSel = document.querySelector('#history-end-time select');
        check(startSel.tagName === 'SELECT' && endSel.tagName === 'SELECT', '24-hour time fields use select dropdowns, not AM/PM inputs');
        const endMinute = endSel.parentElement.querySelectorAll('select')[1];
        check([...endSel.querySelectorAll('option')].every(o => Number(o.value) >= 0 && Number(o.value) <= 23), 'jam 00-23 only');
        check([...endMinute.querySelectorAll('option')].every(o => Number(o.value) >= 0 && Number(o.value) <= 59), 'menit 00-59 only');
        change(startSel, '06'); change(endSel, '23'); change(endMinute, '00'); await tick();
        check(startSel.checkValidity() && endSel.checkValidity(), '24-hour times accepted');
        history.querySelector('form').requestSubmit(); history.querySelector('form').requestSubmit(); await tick();
        const historyCalls = calls.filter(row => row.path.startsWith('/transactions/truck-history?'));
        check(historyCalls.length === 1, 'history prevents duplicate requests');
        const historyQuery = new URL(historyCalls[0].path, location.origin).searchParams;
        check(historyQuery.get('equipmentId') === '10' && historyQuery.get('starttime').startsWith('2026-04-01T06:00') && historyQuery.get('endtime').startsWith('2026-04-02T23:00'), 'truck history sends selected ID and unshifted time');
        history = document.querySelector('.truck-history');
        check(history.textContent.includes('HISTORY-ONLY') && history.textContent.includes('2026-04-01 07:00:00.000'), 'history shows procedure transactions in database time');
        const checkHistoryDetailPosition = () => {
          for (const card of history.querySelectorAll('.transaction-timeline article')) {
            const cardBounds = card.getBoundingClientRect();
            const iconBounds = card.querySelector('.column-details > summary').getBoundingClientRect();
            check(Math.abs(cardBounds.right - iconBounds.right - 7) < 1 && Math.abs(iconBounds.top - cardBounds.top - 5) < 1, 'history detail icon stays at card top right');
          }
        };
        checkHistoryDetailPosition();
        check(history.querySelectorAll('.transaction-timeline li').length === 1 && !history.querySelector('.transaction-timeline').textContent.includes('TerimaRaw'), 'Kirim and Terima exclude raw rows');
        check(![...history.querySelectorAll('.view-tabs button')].some(node => node.textContent.includes('TerimaRaw')), 'raw tab removed from truck timeline');
        check(!history.textContent.includes('ID 72'), 'raw row is not rendered in truck timeline');
        checkHistoryDetailPosition();
        [...history.querySelectorAll('.view-tabs button')].find(node => node.textContent.includes('Aktivitas truck')).click(); await tick();
        check(history.textContent.includes('HISTORY READER') && history.textContent.includes('Tonase 0'), 'history shows second result set and zero tonnage');
        check(history.querySelector('.truck-trip .trip-heading').textContent.includes('Ritase 1') && history.querySelector('.truck-trip .status').textContent === 'Belum lengkap', 'history groups incomplete activity into labeled trip');
        check(history.querySelector('.activity-stage-0 .timeline-marker svg') && history.querySelector('.trip-notes').textContent.includes('Akhir ritase tidak terlihat'), 'activity type icon and incomplete boundary shown');
        checkHistoryDetailPosition();
        const activityTime = history.querySelector('.transaction-timeline .transaction-times');
        check(activityTime.textContent.includes('dtTimeCollected') && activityTime.querySelector('time').textContent === '2026-04-01 06:00:00.000', 'activity shows labeled dtTimeCollected without opening details or shifting time');
        check(activityTime.textContent.includes('NO SK') && activityTime.textContent.includes('Tonase') && activityTime.textContent.includes('Lokasi') && activityTime.querySelectorAll('span').length === 4, 'no SK, tonase and lokasi sit beside dtTimeCollected');
        check(!history.querySelector('.transaction-timeline .transaction-meta'), 'activity drops duplicate tonase row');
        [...history.querySelectorAll('.view-tabs button')].find(node => node.textContent.includes('Kirim / Terima')).click(); await tick();
        const kirimCard = [...history.querySelectorAll('.transaction-timeline article')][0];
        check(kirimCard.querySelector('[title="Cek relasi"]') && kirimCard.textContent.includes('RefRelasi: 77'), 'timeline mirrors analysis relation controls');
        check(history.querySelector('.truck-trip .trip-heading').textContent.includes('Ritase 1') && history.querySelector('.truck-trips').textContent.includes('RefDumpingTonnageID'), 'transaction trip separators explain reference grouping');
        kirimCard.querySelector('[title="Cek relasi"]').click(); await tick();
        check(document.querySelector('.relation-modal[open]') && document.querySelector('#relation-modal-title').textContent.includes('Cek relasi'), 'history opens relation lookup');
        document.querySelector('.relation-modal .panel-heading button').click(); await tick();
        check(!document.querySelector('.relation-modal[open]'), 'relation lookup closes');
        change(document.querySelector('#history-truck'), '11'); await tick();
        history.querySelector('form').requestSubmit(); await tick();
        history = document.querySelector('.truck-history');
        check(history.textContent.includes('Tidak ada transaksi'), 'empty history message shown');
        change(document.querySelector('#history-truck'), '12'); await tick();
        history.querySelector('form').requestSubmit(); await tick();
        history = document.querySelector('.truck-history');
        check(history.querySelector('[role="alert"]').textContent.includes('Database pusat') && !history.querySelector('.transaction-results'), 'history error clears stale results');
        change(document.querySelector('#history-truck'), 'unknown'); await tick();
        const beforeInvalid = calls.length;
        history.querySelector('form').requestSubmit(); await tick();
        history = document.querySelector('.truck-history');
        check(calls.length === beforeInvalid && history.querySelector('[role="alert"]'), 'invalid truck blocked');
        change(document.querySelector('#history-truck'), '333'); await tick();
        history.querySelector('form').requestSubmit(); await tick();
        history = document.querySelector('.truck-history');
        check(history.querySelectorAll('.truck-trip').length === 10 && history.querySelectorAll('.transaction-timeline li').length === 10, 'large history paginates ten complete groups');
        [...history.querySelectorAll('.history-pagination button')].find(node => node.textContent === 'Berikutnya').click(); await tick();
        check(history.querySelector('.trip-heading').textContent.includes('Ritase 11'), 'trip numbering spans pages');
        for (let i = 0; i < 9; i++) { [...history.querySelectorAll('.history-pagination button')].find(node => node.textContent === 'Berikutnya').click(); await tick(); }
        check(history.querySelectorAll('.transaction-timeline li').length === 1 && history.querySelector('.transaction-timeline').textContent.includes('PAGE-101'), 'last history page retains remaining rows');
        check(history.querySelector('.trip-heading').textContent.includes('Ritase 101'), 'last trip number retained');
        check(document.documentElement.scrollWidth <= innerWidth, 'truck history fits narrow viewport');
        button('Monitoring transaksi').click(); await tick();
        check(!document.querySelector('.anomaly-view').hidden && document.querySelector('.sidebar [aria-current="page"]').textContent.includes('Monitoring transaksi'), 'anomaly dashboard opens from sidebar');
        check(calls.some(row => row.path.startsWith('/anomalies?start=')), 'anomaly dashboard loads findings from endpoint');
        check(document.querySelectorAll('.anomaly-table tbody tr').length === 2, 'anomaly table renders endpoint findings');
        check(document.querySelector('.anomaly-kpi.critical strong').textContent === '01' && document.querySelector('.anomaly-kpi.warning strong').textContent === '01', 'anomaly KPI reflects critical and warning findings');
        check(document.querySelector('.anomaly-table').textContent.includes('Kirim tanpa pasangan 7 hari') && document.querySelector('.anomaly-table').textContent.includes('LoadingLocation Kirim kosong'), 'anomaly table shows both finding codes');
        check(document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight, 'anomaly page fits viewport without page scroll');
        const anomalyCalls = calls.length;
        const cdnFilter = document.querySelectorAll('.anomaly-filters input[type="search"]')[1];
        change(cdnFilter, 'AB260029195'); await tick();
        check(calls.length > anomalyCalls, 'anomaly SK filter triggers server query');
        check(document.querySelectorAll('.anomaly-table tbody tr').length === 1 && document.querySelector('.anomaly-table').textContent.includes('AB260029195'), 'anomaly filter narrows findings by SK');
        change(cdnFilter, ''); await tick();
        const anomalyAction = [...document.querySelectorAll('.anomaly-table .anomaly-open')].find(btn => btn.closest('tr').textContent.includes('AB260029085'));
        check(anomalyAction && !anomalyAction.disabled, 'anomaly row provides analysis action');
        anomalyAction.click(); await tick();
        const routeDialog = document.querySelector('.anomaly-route-modal[open]');
        check(routeDialog && routeDialog.textContent.includes('AB260029085') && routeDialog.textContent.includes('TR10040'), 'anomaly action opens destination chooser with target');
        routeDialog.querySelector('.anomaly-route-transaction').click(); await tick();
        check(!document.querySelector('.transactions-page').hidden && document.querySelector('#coal-delivery-number').value === 'AB260029085' && !document.querySelector('.anomaly-route-modal[open]'), 'anomaly action deep-links SK into transaction analysis');
        button('Monitoring transaksi').click(); await tick();
        const anomalyAction2 = [...document.querySelectorAll('.anomaly-table .anomaly-open')].find(btn => btn.closest('tr').textContent.includes('AB260029085'));
        anomalyAction2.click(); await tick();
        document.querySelector('.anomaly-route-timeline').click(); await tick();
        check(!document.querySelector('.truck-history').parentElement.hidden && document.querySelector('#history-truck').value === 'TR10040 · #444', 'anomaly action deep-links truck into timeline');
        check(document.querySelector('#history-start').value === '27/10/2026' && document.querySelector('#history-end').value === '27/10/2026', 'anomaly action fills timeline with finding date');
        const startSelect = document.querySelectorAll('#history-start-time select');
        const endSelect = document.querySelectorAll('#history-end-time select');
        check(startSelect[0].value === '06' && startSelect[1].value === '01' && endSelect[0].value === '12' && endSelect[1].value === '01', 'timeline window is 3 hours before and after finding time');
        check(document.querySelector('.anomaly-target-note').textContent.includes('AB260029085') && !document.querySelector('.anomaly-route-modal[open]'), 'timeline keeps anomaly context and closes chooser');
        button('Equipment checks').click(); await tick();
        check(!document.querySelector('.equipment-page').hidden, 'return to equipment');
        check(!document.querySelector('.equipment-page:not(.activity-page)').hidden && !document.querySelector('.registry').hidden, 'equipment returns directly to API registry');
        check(document.documentElement.scrollHeight <= innerHeight, 'no page vertical scroll');
        check(document.documentElement.scrollWidth <= innerWidth, 'no page horizontal scroll');
        const panel = document.querySelector('.configuration').getBoundingClientRect();
        check(panel.bottom <= innerHeight && panel.width > 0, 'configuration fits viewport');
        requestDelay = 350;
        for (const [menu, formSelector] of [['Analisa transaksi', '.transaction-search'], ['Timeline truck', '.truck-history-search']]) {
          button(menu).click(); await tick();
          const form = document.querySelector(formSelector);
          form.requestSubmit(); await tick();
          const loadingButton = form.querySelector('button[aria-busy="true"]');
          check(loadingButton && loadingButton.disabled, 'loading locks ' + menu + ' submit');
          const spinner = getComputedStyle(loadingButton, '::before');
          check(spinner.animationName === 'process-spin' && spinner.borderRightColor === 'rgba(0, 0, 0, 0)', 'loading spinner animates for ' + menu);
          await new Promise(resolve => setTimeout(resolve, 400));
          check(!form.querySelector('button[aria-busy="true"]'), 'loading clears after ' + menu);
        }
        requestDelay = 0;
        button('Equipment checks').click(); await tick();
        const escapeTrigger = document.querySelector('[aria-label="Hapus API One"]');
        escapeTrigger.focus(); escapeTrigger.click();
        await new Promise(resolve => setTimeout(resolve, 40));
        const escapeModal = document.querySelector('.confirm-modal[open]');
        const writesBeforeEscape = calls.filter(row => row.path === '/apis/one').length;
        check(escapeModal && escapeModal.querySelector('#confirm-message').textContent.includes('tidak dihapus'), 'custom confirmation retains warning text');
        escapeModal.dispatchEvent(new Event('cancel', { cancelable: true })); await tick();
        check(!document.querySelector('.confirm-modal') && document.activeElement === escapeTrigger && calls.filter(row => row.path === '/apis/one').length === writesBeforeEscape, 'Escape cancels without write and restores focus');
        button('Coal calory').click(); await tick();
        const names = () => [...document.querySelectorAll('.coal-calory-panel tbody tr td:nth-child(3)')].map(cell => cell.textContent);
        check(names().join('|') === 'SEAM B|SEAM A|SEAM C', 'coal calory lists rows in fetched order');
        const sortHeader = label => [...document.querySelectorAll('.coal-calory-panel th .sort-header')].find(node => node.textContent.includes(label));
        sortHeader('CoalQualityName').click(); await tick();
        check(names().join('|') === 'SEAM A|SEAM B|SEAM C', 'coal calory sorts ascending by name');
        check(sortHeader('CoalQualityName').closest('th').getAttribute('aria-sort') === 'ascending', 'sorted header exposes aria-sort');
        sortHeader('CoalQualityName').click(); await tick();
        check(names().join('|') === 'SEAM C|SEAM B|SEAM A', 'coal calory sorts descending on second click');
        sortHeader('Coalcalory').click(); await tick();
        const caloryCells = [...document.querySelectorAll('.coal-calory-panel tbody tr td:nth-child(4)')].map(cell => cell.textContent);
        check(caloryCells[caloryCells.length - 1].includes('belum diisi'), 'null calory sorts last');
        // Ekspor: tangkap Blob tanpa benar-benar mengunduh file.
        let exported = null;
        const NativeBlob = window.Blob;
        window.Blob = function (parts, options) { exported = String(parts.join('')); return new NativeBlob(parts, options); };
        URL.createObjectURL = () => 'blob:fixture';
        URL.revokeObjectURL = () => {};
        HTMLAnchorElement.prototype.click = () => {};
        const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
        const BOM = String.fromCharCode(0xFEFF);
        const exportedRows = () => exported.replace(BOM, '').split(CRLF).filter(Boolean);
        document.querySelector('[aria-label="Ekspor CSV"]').click(); await tick();
        const exportDialog = document.querySelector('dialog[aria-labelledby="coal-calory-export-title"]');
        check(exportDialog && exportDialog.open, 'export dialog opens');
        check(exportDialog.querySelector('input[value="empty"]').closest('label').textContent.includes('1 baris'), 'export counts empty calory rows');
        exportDialog.querySelector('input[value="empty"]').click(); await tick();
        exportDialog.querySelector('form').requestSubmit(); await tick();
        const emptyRows = exportedRows();
        check(emptyRows.length === 2 && emptyRows[0] === 'CoalQualityName,Coalcalory' && emptyRows[1] === 'SEAM A,', 'export empty writes only null calory rows with two columns');
        check(!document.querySelector('dialog[aria-labelledby="coal-calory-export-title"]'), 'export closes after download');
        document.querySelector('[aria-label="Ekspor CSV"]').click(); await tick();
        const filledDialog = document.querySelector('dialog[aria-labelledby="coal-calory-export-title"]');
        filledDialog.querySelector('input[value="filled"]').click(); await tick();
        filledDialog.querySelector('form').requestSubmit(); await tick();
        const filledRows = exportedRows();
        check(filledRows.length === 3 && filledRows.includes('SEAM B,5000') && filledRows.includes('SEAM C,6300'), 'export filled writes only rows with calory');
        document.querySelector('[aria-label="Ekspor CSV"]').click(); await tick();
        const allDialog = document.querySelector('dialog[aria-labelledby="coal-calory-export-title"]');
        allDialog.querySelector('form').requestSubmit(); await tick();
        check(exportedRows().length === 4, 'export all writes every active row');
        check(document.documentElement.scrollHeight <= innerHeight, 'coal calory panel fits viewport after sorting');
        button('Equipment checks').click(); await tick();
        document.body.dataset.testResult = 'passed';
      } catch (error) { document.body.dataset.testResult = 'failed: ' + error.message; }
    });
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
      const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-proxy-server', '--window-size=' + size, '--virtual-time-budget=45000', '--dump-dom', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { timeout: 60000 });
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
