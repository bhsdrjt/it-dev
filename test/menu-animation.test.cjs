const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const browser = process.env.CHROME_PATH || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
for (const reduced of [false, true]) test(`menu animation reduced-motion=${reduced}`, { skip: !browser, timeout: 30000 }, async () => {
  const profile = await mkdtemp(join(process.env.TEMP ? join(process.env.TEMP, 'opencode') : process.cwd(), 'menu-animation-'));
  // Same isolated fetch/browser fixtures as permission-layout and audit-browser.
  const script = `
    sessionStorage.setItem('token', 'fixture-only');
    const check = (ok, label) => { if (!ok) throw Error(label); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 50));
    const calls = [];
    window.fetch = async (path, options = {}) => {
      calls.push(path);
      check(!options.method || options.method === 'GET', 'fixture forbids writes');
      let data = [];
      if (path === '/auth/me') data = { username: 'fixture', roles: ['admin'], permissions: ['equipment.view', 'coal.view', 'transactions.view', 'monitoring.view', 'timeline.view', 'activity.view', 'access.manage'] };
      else if (path.startsWith('/anomalies?')) data = { anomalies: [], queries: [] };
      else if (path === '/auth/admin/users') data = { users: [], userRoles: [] };
      else if (path === '/auth/admin/roles') data = { roles: [], permissions: [], rolePermissions: [] };
      else if (path.startsWith('/auth/admin/audit?')) data = { rows: [], offset: 0, limit: 50, hasMore: false };
      else check(['/apis', '/equipments', '/equipments?activeOnly=true', '/locations', '/coal-calories'].includes(path), 'unexpected request: ' + path);
      return { ok: true, json: async () => data };
    };
    window.addEventListener('load', async () => { try {
      await tick();
      check(matchMedia('(prefers-reduced-motion: reduce)').matches === ${reduced}, 'motion preference');
      const sidebar = document.querySelector('.sidebar');
      const buttons = [...sidebar.querySelectorAll('nav button')].filter(n => !n.hidden);
      check(buttons.length === 8, 'all eight menus');
      const roots = new Map();
      const animations = new Map();
      const inspect = button => {
        const roots = [...document.querySelectorAll('.workspace main > .menu-page')];
        const visible = roots.filter(n => !n.hidden);
        check(visible.length === 1, 'one visible page');
        const root = visible[0], style = getComputedStyle(root);
        check(style.animationName === (${reduced} ? 'none' : 'menu-enter'), 'visible animation: ' + button.textContent);
        if (!${reduced}) {
          check(style.animationDuration === '0.18s' && style.animationTimingFunction === 'ease-out', 'animation timing');
          const animation = root.getAnimations().find(a => a.animationName === 'menu-enter');
          check(animation, 'live page animation');
          const frames = animation.effect.getKeyframes();
          check(frames[0].opacity === '0' && frames[0].transform === 'translateY(6px)', 'fade and six-pixel entry');
          check(animation !== animations.get(button), 'fresh animation on return');
          animations.set(button, animation);
        }
        for (const hidden of roots.filter(n => n.hidden)) {
          check(getComputedStyle(hidden).display === 'none', 'hidden display none');
          check(hidden.getAnimations().length === 0, 'hidden animation reset');
        }
        check(document.querySelector('.sidebar') === sidebar && sidebar.getAnimations().length === 0, 'sidebar unchanged');
        return root;
      };
      check(calls.length === 2, 'unvisited pages do not fetch');
      for (const button of buttons) {
        button.focus(); button.click(); await tick();
        roots.set(button, inspect(button));
        check(document.activeElement === button, 'menu focus retained');
      }
      for (const button of buttons) {
        const before = calls.length;
        button.click(); await tick();
        const root = inspect(button);
        if (!root.matches('.access-page, .audit-page')) {
          check(root === roots.get(button), 'visited root retained');
          check(calls.length === before, 'visited page does not reload');
        }
      }
      document.body.dataset.testResult = 'passed';
    } catch (error) { document.body.dataset.testResult = 'failed: ' + error.message; } });
  `;
  const server = createServer(async (req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(join(__dirname, '../public', req.url.slice(1))));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>' + script + '</script><script src="/app.js"></script>');
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-proxy-server', ...(reduced ? ['--force-prefers-reduced-motion'] : []), '--virtual-time-budget=10000', '--dump-dom', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { timeout: 20000 });
      let text = ''; child.stdout.on('data', data => { text += data; }); child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text) : reject(Error('Browser exited: ' + code)));
    });
    assert.match(output, /data-test-result="passed"/, output.match(/data-test-result="[^"]*"/)?.[0] || 'Browser test did not finish');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
