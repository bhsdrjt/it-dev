const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
for (const size of ['1280,720', '390,844']) test(`access forms remain reachable and unclipped ${size}`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'access-test-'));
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    const roles = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: 'role_' + 'long_code_'.repeat(8) + i }));
    const permissions = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: 'transactions.' + 'long_permission_code_'.repeat(5) + i }));
    const writes = [];
    let failSave = false;
    window.fetch = async (path, options = {}) => {
      if (options.method === 'PUT' || options.method === 'POST') {
        writes.push({ path, body: JSON.parse(options.body) });
        if (failSave) return { ok: false, status: 400, json: async () => ({ message: 'Fixture save failed' }) };
        return { ok: true, json: async () => ({}) };
      }
      const data = path === '/auth/me' ? { userId: 1, username: 'admin', displayName: 'Admin', permissions: ['access.manage'] }
        : path === '/auth/admin/users' ? { users: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, username: 'user_' + i, displayName: 'User ' + i, isActive: true })), userRoles: [{ userId: 1, roleId: 1 }] }
        : path === '/auth/admin/roles' ? { roles, permissions, rolePermissions: [{ roleId: 1, permissionId: 1 }] } : [];
      return { ok: true, json: async () => data };
    };
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 100));
    window.addEventListener('load', async () => {
      try {
        await tick();
        [...document.querySelectorAll('button')].find(node => node.textContent.includes('Manajemen akses')).click();
        await tick();
        const page = document.querySelector('.access-page');
        check(page && page.querySelectorAll('#access-users .access-record').length === 5, 'all users loaded');
        check(page.querySelectorAll('#access-roles .access-record').length === 4, 'all roles loaded');
        check(!page.querySelector('dialog[open]') && !page.querySelector('details'), 'all editors use closed modals');
        check(!/pengguna/i.test(page.textContent), 'access terminology uses user');
        check(!page.textContent.includes('Pilih role untuk') && !page.textContent.includes('Kelola akun') && !page.textContent.includes('Pilih pengguna') && !page.textContent.includes('Perubahan izin berlaku'), 'requested descriptions removed');
        check(document.querySelector('#access-roles').hidden, 'permissions separate from users');
        page.getAnimations().forEach(animation => animation.finish());
        const visible = node => node.checkVisibility();
        const layout = (container = page) => {
          check(container.scrollWidth <= container.clientWidth + 1, 'long codes do not cause horizontal overflow');
          for (const card of page.querySelectorAll('.access-card')) if (visible(card)) {
            check(card.scrollHeight <= card.clientHeight + 1, 'card contains forms without clipping');
          }
          for (const input of container.querySelectorAll('input, select, button, summary')) if (visible(input)) {
            input.scrollIntoView({ block: 'center' });
            const rect = input.getBoundingClientRect();
            const bounds = container.getBoundingClientRect();
            check(rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, 'control fully visible after scroll: ' + input.tagName);
            check(input.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), 'control not clipped or covered');
            if (input.type === 'checkbox') check(rect.width === 18 && rect.height === 18, 'checkbox keeps native compact size');
            else check(rect.height >= 36, 'fields and actions remain usable');
            if (['INPUT', 'SELECT'].includes(input.tagName)) check(input.labels.length > 0, 'input has semantic label');
          }
        };
        for (const theme of ['light', 'dark']) {
          document.documentElement.dataset.theme = theme;
          document.querySelector('#access-users-tab').click(); await tick();
          layout();
          const add = page.querySelector('button[aria-label="Tambah user"]');
          add.focus(); add.click(); await tick();
          const createModal = page.querySelector('.access-modal[open]');
          check(createModal.matches(':modal'), 'create user opens native modal');
          layout(createModal.querySelector('.access-modal-body'));
          check(createModal.querySelector('input[name="password"]').minLength === 12, 'new user password validation retained');
          createModal.querySelector('[aria-label="Tutup"]').click(); await tick();
          check(document.activeElement === add, 'create close restores focus');
          check(getComputedStyle(page.querySelector('.access-card')).backgroundColor === (theme === 'dark' ? 'rgb(26, 33, 41)' : 'rgb(255, 255, 255)'), 'card uses theme surface');
          for (const section of ['users', 'roles']) {
            document.querySelector('#access-' + section + '-tab').click(); await tick();
            const trigger = page.querySelector('#access-' + section + ' .access-record-row > button');
            check(trigger.textContent === '' && trigger.querySelector('svg') && trigger.title === trigger.getAttribute('aria-label'), 'icon action has tooltip and accessible name');
            trigger.focus(); trigger.click(); await tick();
            const modal = page.querySelector('.access-modal[open]');
            check(modal && modal.matches(':modal'), 'editor uses native modal');
            check(modal.contains(document.activeElement), 'focus moves inside modal');
            check(modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= innerWidth, 'modal fits viewport');
            check(getComputedStyle(modal).backgroundColor === (theme === 'dark' ? 'rgb(26, 33, 41)' : 'rgb(255, 255, 255)'), 'modal uses theme surface');
            layout(modal.querySelector('.access-modal-body'));
            if (section === 'users') {
              check(modal.querySelector('input[name="isActive"]').checked, 'active state retained');
              check(modal.querySelector('input[name="roleIds"]').checked, 'role assignment retained');
            } else {
              check(modal.querySelector('input[name="permissionIds"]').checked, 'permission assignment retained');
              check(modal.querySelector('.access-modal-body').scrollHeight > modal.querySelector('.access-modal-body').clientHeight, 'long permissions scroll inside modal');
            }
            modal.querySelector('[aria-label="Tutup"]').click(); await tick();
            check(!modal.open && document.activeElement === trigger, 'close restores trigger focus');
          }
        }
        document.querySelector('#access-users-tab').click(); await tick();
        const search = page.querySelector('input[type="search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'user_3');
        search.dispatchEvent(new Event('input', { bubbles: true })); await tick();
        check([...page.querySelectorAll('#access-users .access-record')].filter(visible).length === 1, 'search filters users');
        const status = page.querySelector('select');
        status.value = 'inactive'; status.dispatchEvent(new Event('change', { bubbles: true })); await tick();
        check(page.querySelector('.access-empty').textContent.includes('User tidak ditemukan'), 'filter empty state');
        status.value = 'all'; status.dispatchEvent(new Event('change', { bubbles: true })); await tick();
        const record = [...page.querySelectorAll('#access-users .access-record')].find(visible);
        const trigger = record.querySelector('.access-record-row > button');
        trigger.focus(); trigger.click(); await tick();
        const modal = record.querySelector('dialog');
        const form = modal.querySelector('form');
        form.querySelector('input[name="displayName"]').value = 'Edited name';
        form.querySelector('button').focus(); form.requestSubmit(); await tick();
        check(modal.querySelector('.confirm-modal:modal'), 'save confirmation nested inside editor');
        modal.dispatchEvent(new Event('cancel', { cancelable: true }));
        check(modal.open, 'editor cannot close during save confirmation');
        modal.querySelector('.confirm-actions button').click(); await tick();
        check(writes.length === 0, 'cancel does not write');
        check(form.querySelector('input[name="displayName"]').value === 'Edited name', 'cancel preserves edits');
        failSave = true;
        form.querySelector('button').focus(); form.requestSubmit(); await tick();
        modal.querySelector('.confirm-actions .primary').click(); await tick();
        check(modal.querySelector('[role="alert"]').textContent.includes('Fixture save failed'), 'save error visible inside modal');
        failSave = false;
        form.querySelector('button').focus(); form.requestSubmit(); await tick();
        modal.querySelector('.confirm-actions .primary').click(); await tick();
        check(writes.at(-1).path === '/auth/admin/users/4' && writes.at(-1).body.displayName === 'Edited name' && !('password' in writes.at(-1).body), 'user save retains API payload');
        check(modal.querySelector('[role="status"]').textContent.includes('tersimpan'), 'save feedback visible inside modal');
        modal.querySelector('[aria-label="Tutup"]').click(); await tick();
        trigger.focus(); trigger.click(); await tick();
        check(form.querySelector('input[name="displayName"]').value === 'Edited name', 'reopening preserves draft');
        modal.querySelector('[aria-label="Tutup"]').click(); await tick();
        document.querySelector('#access-roles-tab').click(); await tick();
        const roleTrigger = page.querySelector('#access-roles .access-record-row > button');
        roleTrigger.focus(); roleTrigger.click(); await tick();
        const roleModal = page.querySelector('.access-modal[open]');
        roleModal.querySelector('input[value="2"]').click();
        roleModal.querySelector('.access-form button').focus(); roleModal.querySelector('form').requestSubmit(); await tick();
        roleModal.querySelector('.confirm-actions .primary').click(); await tick();
        check(writes.at(-1).path === '/auth/admin/roles/1/permissions' && writes.at(-1).body.permissionIds.join(',') === '1,2', 'permission modal saves selected IDs');
        roleModal.querySelector('[aria-label="Tutup"]').click(); await tick();
        document.querySelector('#access-users-tab').click(); await tick();
        const add = page.querySelector('button[aria-label="Tambah user"]');
        add.focus(); add.click(); await tick();
        const createModal = page.querySelector('.access-modal[open]');
        const createForm = createModal.querySelector('form');
        createForm.querySelector('[name="username"]').value = 'new_user';
        createForm.querySelector('[name="displayName"]').value = 'New User';
        createForm.querySelector('[name="password"]').value = 'fixture-password-123';
        createForm.querySelector('[name="roleIds"]').click();
        createForm.querySelector('button').focus(); createForm.requestSubmit(); await tick();
        createModal.querySelector('.confirm-actions .primary').click(); await tick();
        check(writes.at(-1).path === '/auth/admin/users' && writes.at(-1).body.username === 'new_user' && writes.at(-1).body.roleIds.join(',') === '1', 'create modal preserves API payload');
        check(createForm.querySelector('[name="password"]').value === '' && createForm.querySelector('[name="username"]').value === '', 'successful create resets form and password');
        check(createModal.querySelector('[role="status"]').textContent.includes('tersimpan'), 'create success visible inside modal');
        createModal.querySelector('[aria-label="Tutup"]').click(); await tick();
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
