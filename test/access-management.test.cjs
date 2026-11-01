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
    window.fetch = async path => {
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
        check(page && page.querySelectorAll('.access-card').length === 10, 'all user and role cards loaded');
        page.getAnimations().forEach(animation => animation.finish()); // Measure settled layout, not fractional entry transforms.
        for (const theme of ['light', 'dark']) {
          document.documentElement.dataset.theme = theme;
          check(page.scrollHeight > page.clientHeight, 'long page owns vertical scroll');
          check(page.scrollWidth <= page.clientWidth + 1, 'long codes do not cause horizontal overflow');
          for (const card of page.querySelectorAll('.access-card')) {
            check(card.scrollHeight <= card.clientHeight + 1, 'card contains forms without clipping');
          }
          for (const input of page.querySelectorAll('input, button')) {
            input.scrollIntoView({ block: 'center' });
            const rect = input.getBoundingClientRect();
            const bounds = page.getBoundingClientRect();
            check(rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right, 'control fully visible after scroll');
            check(input.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), 'control not clipped or covered');
            if (input.type === 'checkbox') check(rect.width === 18 && rect.height === 18, 'checkbox keeps native compact size');
            else check(rect.height >= 36, 'text fields and buttons remain usable');
            if (input.tagName === 'INPUT') check(input.labels.length > 0, 'input has semantic label');
          }
          const grid = page.querySelector('.access-options');
          check(getComputedStyle(grid).gridTemplateColumns.split(' ').length === (innerWidth <= 700 ? 1 : 3), 'responsive permission grid');
          check(getComputedStyle(page.querySelector('.access-card')).backgroundColor === (theme === 'dark' ? 'rgb(26, 33, 41)' : 'rgb(255, 255, 255)'), 'card uses theme surface');
        }
        check(page.querySelector('input[name="isActive"]').checked, 'active state retained');
        check(page.querySelector('input[name="permissionIds"]').checked, 'permission assignment retained');
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
