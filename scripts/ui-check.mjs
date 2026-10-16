// Headless check of the built page in light and dark, with a synthetic
// 90-day scenario. Needs playwright-core: set PLAYWRIGHT_MODULE to its path.
// Usage: node scripts/ui-check.mjs <screenshot-dir>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { emptyHistory, record } from '../public/model.mjs';

process.env.PWDEBUG = '0';
process.env.PLAYWRIGHT_HTML_OPEN = 'never';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const output = resolve(process.argv[2] ?? '.artifacts/ui');
const root = resolve('.artifacts/site');
await mkdir(output, { recursive: true });
await rm(root, { recursive: true, force: true });
await cp('dist', root, { recursive: true });

// Scenario: GitHub degraded upstream now; the website had an outage 12 days ago.
const config = JSON.parse(await readFile('config/services.json', 'utf8'));
const NOW = Date.now();
let history = emptyHistory();
let incidents = [];
for (let day = 89; day >= 0; day -= 1) {
  for (let check = 0; check < 6; check += 1) {
    const at = NOW - day * 86400000 - (5 - check) * 600000;
    const results = config.services.map((s) => {
      let level = 'operational';
      if (s.id === 'website' && day === 12 && check < 3) level = 'major_outage';
      if (s.id === 'github' && day === 0) level = 'degraded';
      if (s.id === 'downloads' && day === 40 && check === 2) level = 'partial_outage';
      return { id: s.id, name: s.name, level, detail: level === 'operational' ? 'ok' : s.id === 'website' ? 'Home page: Connection failed' : 'Pages: degraded performance', probed: !s.feed };
    });
    ({ history, incidents } = record(history, incidents, results, at));
  }
}
incidents.push({ id: 'github:x', serviceId: 'github', title: 'Delays in GitHub Pages builds', level: 'degraded', stage: 'identified', origin: 'upstream', startedAt: new Date(NOW - 3600000).toISOString(), updatedAt: new Date(NOW - 600000).toISOString(), resolvedAt: null, url: 'https://www.githubstatus.com' });
const status = JSON.parse(await readFile(join(root, 'data/status.json'), 'utf8'));
status.generatedAt = new Date(NOW - 4 * 60000).toISOString();
const github = status.services.find((s) => s.id === 'github');
Object.assign(github, { level: 'degraded', detail: 'Delays in GitHub Pages builds' });
github.components.find((c) => c.name === 'Pages').level = 'degraded';
await writeFile(join(root, 'data/status.json'), JSON.stringify(status));
await writeFile(join(root, 'data/history.json'), JSON.stringify(history));
await writeFile(join(root, 'data/incidents.json'), JSON.stringify({ schemaVersion: 1, incidents }));

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const errors = [];
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1000, height: 1300 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    await page.goto(origin);
    await page.locator('#main[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('#banner').getAttribute('data-level'), 'degraded');
    assert.match(await page.locator('#banner-title').textContent(), /SpecWeave is operational/);
    assert.deepEqual(await page.locator('section.card[data-group-id]').evaluateAll((n) => n.map((x) => x.dataset.groupId)), ['specweave', 'specwithcode', 'dependencies']);
    assert.equal(await page.locator('[data-service-id="website"] .bar').count(), 90);
    assert.equal(await page.locator('[data-service-id="website"] .bar').nth(77).getAttribute('data-level'), 'major_outage');
    assert.equal(await page.locator('[data-service-id="downloads"] .bar').nth(49).getAttribute('data-level'), 'degraded');
    const incidentsText = await page.locator('#incidents').textContent();
    assert.match(incidentsText, /Delays in GitHub Pages builds/);
    assert.match(incidentsText, /Home page: Connection failed/);
    assert.match(incidentsText, /Resolved/);
    // GitHub is degraded, so it opens with components, dependents and source.
    const githubRow = page.locator('[data-service-id="github"]');
    assert.match(await githubRow.textContent(), /Used by.*spec-weave\.com \(GitHub Pages\)/);
    assert.match(await githubRow.textContent(), /githubstatus\.com/);
    await page.screenshot({ path: join(output, `status-${theme}.png`), fullPage: true });

    await page.locator('[data-service-id="website"] .service-toggle').click();
    assert.match(await page.locator('[data-service-id="website"]').textContent(), /Depends on.*GitHub: Needs attention/);
    await page.locator('[data-service-id="website"] .bar').nth(77).hover();
    const popover = page.locator('#day-popover');
    assert.match(await popover.textContent(), /3 of 6 checks found a problem/);
    assert.match(await popover.textContent(), /Related incidents/);
    await page.screenshot({ path: join(output, `status-${theme}-hover.png`) });
    await page.keyboard.press('Escape');

    await page.locator('[data-group-id="dependencies"] .group-head').click();
    assert.equal(await page.locator('[data-service-id="github"]').count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`ui-check passed; screenshots in ${output}`);
} finally {
  await browser.close();
  server.close();
}
