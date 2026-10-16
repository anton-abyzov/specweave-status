// Runs every check once and folds the result into data/. Read-only against
// public endpoints; a failed fetch becomes a status, never a crash.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { LABELS, emptyHistory, parseStatuspage, record, rollup, rollupKnown } from '../public/model.mjs';

const TIMEOUT_MS = 15_000;
const SLOW_MS = 6_000;
const USER_AGENT = 'specweave-status (+https://status.spec-weave.com)';

const config = JSON.parse(await readFile(new URL('../config/services.json', import.meta.url), 'utf8'));
const load = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};

async function fetchOnce(url, init = {}) {
  const started = performance.now();
  const headers = { 'user-agent': USER_AGENT, ...(init.headers ?? {}) };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers });
  const body = init.method === 'HEAD' || init.discardBody ? '' : await response.text();
  if (init.discardBody) await response.body?.cancel().catch(() => {});
  return { status: response.status, ok: response.ok, body, ms: Math.round(performance.now() - started) };
}

/** One retry: a single dropped connection from a CI runner is not an outage. */
async function fetchWithRetry(url, init) {
  try {
    const first = await fetchOnce(url, init);
    if (first.status < 500) return first;
  } catch {}
  await new Promise((done) => setTimeout(done, 3000));
  return fetchOnce(url, init);
}

const result = (check, level, detail, ms = null) => ({ id: check.id, name: check.name, level, detail, ms });

async function probe(check) {
  try {
    const init = check.kind === 'download' ? { headers: { range: 'bytes=0-0' }, discardBody: true } : {};
    const response = await fetchWithRetry(check.url, init);
    if (!response.ok) {
      return result(check, response.status >= 500 || response.status === 404 ? 'major_outage' : 'partial_outage', `HTTP ${response.status}`, response.ms);
    }
    const slow = response.ms > SLOW_MS;
    const timing = `${response.ms} ms`;
    switch (check.kind) {
      case 'http':
        if (check.expect && !response.body.includes(check.expect)) return result(check, 'partial_outage', 'Page loaded without its expected content', response.ms);
        return result(check, slow ? 'degraded' : 'operational', slow ? `Slow response (${timing})` : `Responding in ${timing}`, response.ms);
      case 'download':
        return result(check, slow ? 'degraded' : 'operational', slow ? `Slow response (${timing})` : 'Download available', response.ms);
      case 'npm': {
        const version = JSON.parse(response.body).version;
        if (typeof version !== 'string') return result(check, 'partial_outage', 'Registry returned no version', response.ms);
        return result(check, slow ? 'degraded' : 'operational', `specweave@${version}`, response.ms);
      }
      case 'release': {
        const release = JSON.parse(response.body);
        if (typeof release.tag_name !== 'string') return result(check, 'partial_outage', 'No published release', response.ms);
        const date = new Date(release.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        return result(check, 'operational', `${release.tag_name}, published ${date}`, response.ms);
      }
      case 'json': {
        const json = JSON.parse(response.body);
        if (check.expectKey && !(check.expectKey in json)) return result(check, 'partial_outage', `Missing "${check.expectKey}"`, response.ms);
        return result(check, slow ? 'degraded' : 'operational', json.version ? `Version ${json.version}` : `Responding in ${timing}`, response.ms);
      }
      default:
        return result(check, 'unknown', 'Unsupported check');
    }
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return result(check, 'major_outage', timeout ? 'Timed out' : 'Connection failed');
  }
}

async function readFeed(service) {
  try {
    const response = await fetchWithRetry(service.feed.url, { headers: { accept: 'application/json' } });
    return parseStatuspage(response.ok ? JSON.parse(response.body) : null, service.feed, service.id);
  } catch {
    return parseStatuspage(null, service.feed, service.id);
  }
}

const now = Date.now();
const services = await Promise.all(config.services.map(async (service) => {
  if (service.feed) {
    const feed = await readFeed(service);
    return { id: service.id, name: service.name, level: feed.level, detail: feed.detail, components: feed.components, upstream: feed.incidents, probed: false };
  }
  const components = await Promise.all(service.checks.map(probe));
  const level = rollupKnown(components.map((c) => c.level));
  const worst = components.find((c) => c.level === level && level !== 'operational');
  return {
    id: service.id,
    name: service.name,
    level,
    detail: worst ? `${worst.name}: ${worst.detail}` : `${components.length === 1 ? components[0].detail : `All ${components.length} checks passing`}`,
    components,
    upstream: [],
    probed: true,
  };
}));

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const historyPath = new URL('../data/history.json', import.meta.url);
const incidentsPath = new URL('../data/incidents.json', import.meta.url);
const previous = await load(incidentsPath, { schemaVersion: 1, incidents: [] });

// Upstream incidents: keep each one seen; when it leaves the feed it is resolved.
const at = new Date(now).toISOString();
const seenUpstream = new Map(services.flatMap((s) => s.upstream).map((i) => [i.id, i]));
const feedOk = new Set(services.filter((s) => !s.probed && s.level !== 'unknown').map((s) => s.id));
let incidents = previous.incidents.map((incident) => {
  if (incident.origin !== 'upstream') return incident;
  const current = seenUpstream.get(incident.id);
  seenUpstream.delete(incident.id);
  if (current) return { ...incident, ...current };
  if (!incident.resolvedAt && feedOk.has(incident.serviceId)) return { ...incident, stage: 'resolved', updatedAt: at, resolvedAt: at };
  return incident;
});
incidents.push(...seenUpstream.values());

const folded = record(await load(historyPath, emptyHistory()), incidents, services, now);
incidents = folded.incidents;

const status = {
  schemaVersion: 1,
  generatedAt: at,
  level: rollup(services.map((s) => s.level)),
  services: services.map(({ upstream, probed, ...service }) => service),
};
await writeFile(new URL('../data/status.json', import.meta.url), `${JSON.stringify(status, null, 2)}\n`);
await writeFile(historyPath, `${JSON.stringify(folded.history)}\n`);
await writeFile(incidentsPath, `${JSON.stringify({ schemaVersion: 1, incidents }, null, 2)}\n`);

for (const service of services) console.log(`${service.id.padEnd(12)} ${LABELS[service.level].padEnd(16)} ${service.detail}`);
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `observed_at=${at}\n`, { flag: 'a' });
