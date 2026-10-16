import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { dayLevel, emptyHistory, headline, parseStatuspage, record, rollup, serviceDays, uptime } from '../public/model.mjs';

const NOW = Date.parse('2026-10-16T15:00:00Z');
const DAY = 86400000;
const result = (level, id = 'website') => ({ id, name: 'spec-weave.com', level, detail: level === 'operational' ? 'ok' : 'Connection failed', probed: true });

test('config is valid and every dependency it names exists', async () => {
  const config = JSON.parse(await readFile(new URL('../config/services.json', import.meta.url), 'utf8'));
  const ids = new Set(config.services.map((s) => s.id));
  const groups = new Set(config.groups.map((g) => g.id));
  assert.equal(ids.size, config.services.length);
  for (const service of config.services) {
    assert.ok(groups.has(service.group), service.id);
    assert.ok(service.feed || service.checks?.length, service.id);
    assert.ok(service.usedBy?.length, service.id);
    for (const dep of service.dependsOn ?? []) assert.ok(ids.has(dep), `${service.id} -> ${dep}`);
  }
});

test('reads Statuspage components and only incidents on tracked components', () => {
  const feed = { components: ['Pages', 'Actions'], page: 'https://www.githubstatus.com' };
  const parsed = parseStatuspage({
    components: [
      { id: 'a', name: 'Pages', status: 'degraded_performance' },
      { id: 'b', name: 'Actions', status: 'operational' },
      { id: 'c', name: 'Copilot', status: 'major_outage' },
    ],
    incidents: [
      { id: '1', name: 'Pages builds delayed', status: 'identified', impact: 'minor', started_at: '2026-10-16T14:00:00Z', shortlink: 'https://stspg.io/1', components: [{ id: 'a' }] },
      { id: '2', name: 'Copilot down', status: 'investigating', impact: 'critical', started_at: '2026-10-16T14:00:00Z', components: [{ id: 'c' }] },
    ],
  }, feed, 'github');
  assert.deepEqual(parsed.components.map((c) => [c.name, c.level]), [['Pages', 'degraded'], ['Actions', 'operational']]);
  assert.equal(parsed.level, 'degraded');
  assert.deepEqual(parsed.incidents.map((i) => i.title), ['Pages builds delayed']);
  assert.equal(parseStatuspage(null, feed, 'github').level, 'unknown');
});

test('ignoreUnlisted drops incidents that name no component', () => {
  const json = { components: [{ id: 'a', name: 'CDN/Cache', status: 'operational' }], incidents: [{ id: '9', name: 'Regional issue', status: 'investigating', impact: 'minor', started_at: '2026-10-16T14:00:00Z', components: [] }] };
  assert.equal(parseStatuspage(json, { components: ['CDN/Cache'], ignoreUnlisted: true }, 'cloudflare').incidents.length, 0);
  assert.equal(parseStatuspage(json, { components: ['CDN/Cache'] }, 'cloudflare').incidents.length, 1);
});

test('opens an incident after two failed checks and resolves after two healthy ones', () => {
  let history = emptyHistory();
  let incidents = [];
  const step = (level, at) => ({ history, incidents } = record(history, incidents, [result(level)], at));
  step('major_outage', NOW);
  assert.equal(incidents.length, 0);
  step('major_outage', NOW + 600000);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].startedAt, new Date(NOW).toISOString());
  step('operational', NOW + 1200000);
  assert.equal(incidents[0].stage, 'monitoring');
  step('operational', NOW + 1800000);
  assert.equal(incidents[0].stage, 'resolved');
  const today = serviceDays(history, 'website', NOW).at(-1);
  assert.deepEqual([today.level, today.checks, today.failures], ['major_outage', 4, 2]);
  assert.equal(uptime(history, 'website', NOW), 50);
});

test('a single failed check among many is capped at Needs attention; old days drop', () => {
  assert.equal(dayLevel({ operational: 140, major_outage: 1 }), 'degraded');
  assert.equal(dayLevel({ operational: 140, major_outage: 2 }), 'major_outage');
  assert.equal(dayLevel({}), 'unknown');
  let { history } = record(emptyHistory(), [], [result('operational')], NOW - 120 * DAY);
  ({ history } = record(history, [], [result('operational')], NOW));
  assert.deepEqual(Object.keys(history.days), ['2026-10-16']);
  assert.equal(serviceDays(history, 'website', NOW).length, 90);
});

test('banner separates our services from upstream trouble', () => {
  const groups = [{ id: 'specweave' }, { id: 'dependencies' }];
  assert.equal(headline([{ name: 'Site', group: 'specweave', level: 'operational' }], groups).title, 'All systems operational');
  const upstream = headline([{ name: 'Site', group: 'specweave', level: 'operational' }, { name: 'GitHub', group: 'dependencies', level: 'degraded' }], groups);
  assert.equal(upstream.title, 'SpecWeave is operational');
  const own = headline([{ name: 'Site', group: 'specweave', level: 'major_outage' }], groups);
  assert.equal(own.title, '1 service needs attention');
  assert.equal(rollup(['operational', 'unknown']), 'unknown');
});
