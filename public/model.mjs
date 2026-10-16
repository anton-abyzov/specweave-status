// Pure status model shared by the collector (Node) and the page (browser).

export const LEVELS = ['major_outage', 'partial_outage', 'degraded', 'unknown', 'maintenance', 'operational'];
export const LABELS = {
  operational: 'Operational',
  degraded: 'Needs attention',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  unknown: 'Unknown',
};
export const HISTORY_DAYS = 90;
/** Consecutive checks needed to open or resolve an incident. */
export const CONFIRMATIONS = 2;
const MAX_NOTES = 4;
const MAX_INCIDENTS = 200;

export const isLevel = (value) => LEVELS.includes(value);
const healthy = (level) => level === 'operational' || level === 'maintenance';

/** The worst level; unknown when there is nothing to judge. */
export function rollup(levels) {
  let worst = null;
  for (const level of levels) {
    const rank = LEVELS.indexOf(level);
    if (rank >= 0 && (worst === null || rank < worst)) worst = rank;
  }
  return worst === null ? 'unknown' : LEVELS[worst];
}

/** Worst known level; unknown only when nothing is known. */
export function rollupKnown(levels) {
  const known = [...levels].filter((level) => level !== 'unknown');
  return known.length ? rollup(known) : 'unknown';
}

export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function historyDates(now, days = HISTORY_DAYS) {
  const today = Date.parse(`${utcDate(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => utcDate(today - (days - 1 - i) * 86400000));
}

const COMPONENT_LEVELS = {
  operational: 'operational',
  degraded_performance: 'degraded',
  partial_outage: 'partial_outage',
  major_outage: 'major_outage',
  under_maintenance: 'maintenance',
};
const IMPACT_LEVELS = { none: 'degraded', minor: 'degraded', major: 'partial_outage', critical: 'major_outage', maintenance: 'maintenance' };
const STAGES = ['investigating', 'identified', 'monitoring', 'resolved'];

/**
 * Reads an Atlassian Statuspage summary.json into components and incidents
 * for the listed component names. Anything unreadable becomes unknown.
 */
export function parseStatuspage(json, feed, serviceId) {
  if (!json || !Array.isArray(json.components)) {
    return { level: 'unknown', detail: 'Public status page unavailable.', components: [], incidents: [] };
  }
  const wanted = new Set(feed.components);
  const components = [];
  const ids = new Set();
  const seen = new Set();
  for (const component of json.components) {
    if (!component || component.group === true || !wanted.has(component.name) || seen.has(component.name)) continue;
    seen.add(component.name);
    ids.add(component.id);
    const level = COMPONENT_LEVELS[component.status] ?? 'unknown';
    components.push({
      id: component.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: component.name,
      level,
      detail: level === 'operational' ? null : String(component.status).replaceAll('_', ' '),
    });
  }
  const incidents = [];
  for (const incident of Array.isArray(json.incidents) ? json.incidents : []) {
    if (!incident?.name || !incident.started_at && !incident.created_at) continue;
    const touched = (incident.components ?? []).map((c) => c.id);
    // Keep incidents on a tracked component; `ignoreUnlisted` also drops ones that name no component.
    if (touched.length > 0 ? !touched.some((id) => ids.has(id)) : feed.ignoreUnlisted) continue;
    const stage = STAGES.includes(incident.status) ? incident.status : incident.status === 'postmortem' ? 'resolved' : 'investigating';
    const startedAt = new Date(incident.started_at ?? incident.created_at).toISOString();
    incidents.push({
      id: `${serviceId}:${incident.id}`,
      serviceId,
      title: String(incident.name).slice(0, 240),
      level: IMPACT_LEVELS[incident.impact] ?? 'degraded',
      stage,
      origin: 'upstream',
      startedAt,
      updatedAt: new Date(incident.updated_at ?? startedAt).toISOString(),
      resolvedAt: stage === 'resolved' ? new Date(incident.resolved_at ?? incident.updated_at ?? startedAt).toISOString() : null,
      url: typeof incident.shortlink === 'string' ? incident.shortlink : feed.page,
    });
  }
  const open = incidents.filter((incident) => !incident.resolvedAt);
  const level = rollup([...components.map((c) => c.level), ...open.map((i) => i.level), 'operational']);
  const affected = components.filter((c) => c.level !== 'operational');
  return {
    level: components.length === 0 && open.length === 0 ? 'unknown' : level,
    detail: open[0]?.title ?? (affected.length ? `${affected.map((c) => c.name).join(', ')}: ${affected[0].detail}` : 'All tracked components operational.'),
    components,
    incidents,
  };
}

/** A day's level: the worst seen, with a single failed check among many capped at Needs attention. */
export function dayLevel(counts = {}) {
  const known = LEVELS.filter((level) => level !== 'unknown' && (counts[level] ?? 0) > 0);
  if (!known.length) return 'unknown';
  const worst = rollup(known);
  const total = known.reduce((sum, level) => sum + counts[level], 0);
  if (!healthy(worst) && counts[worst] === 1 && total > 1) return rollup(['degraded', ...known.filter((l) => l !== worst)]);
  return worst;
}

export function emptyHistory() {
  return { schemaVersion: 1, days: {}, streaks: {} };
}

/** Folds one round of service results into history and incidents. */
export function record(history, incidents, results, now) {
  const date = utcDate(now);
  const at = new Date(now).toISOString();
  const day = { ...(history.days[date] ?? {}) };
  const streaks = { ...history.streaks };
  const list = [...incidents];
  for (const result of results) {
    const entry = day[result.id] ?? { counts: {}, notes: [] };
    const counts = { ...entry.counts, [result.level]: (entry.counts[result.level] ?? 0) + 1 };
    const note = result.level !== 'operational' && result.level !== 'unknown' ? result.detail : null;
    const notes = note && !entry.notes.includes(note) && entry.notes.length < MAX_NOTES ? [...entry.notes, note] : entry.notes;
    day[result.id] = { counts, notes };
    if (!result.probed || result.level === 'unknown') continue;
    const previous = streaks[result.id];
    const same = previous && healthy(previous.level) === healthy(result.level);
    const streak = { level: result.level, count: same ? previous.count + 1 : 1, since: same ? previous.since ?? now : now };
    streaks[result.id] = streak;
    const index = list.findIndex((i) => i.origin === 'probe' && i.serviceId === result.id && !i.resolvedAt);
    if (healthy(result.level)) {
      if (index >= 0 && streak.count >= CONFIRMATIONS) list[index] = { ...list[index], stage: 'resolved', updatedAt: at, resolvedAt: at };
      else if (index >= 0) list[index] = { ...list[index], stage: 'monitoring', updatedAt: at };
    } else if (index >= 0) {
      list[index] = { ...list[index], level: rollup([list[index].level, result.level]), stage: 'identified', updatedAt: at };
    } else if (streak.count >= CONFIRMATIONS) {
      list.push({
        id: `probe:${result.id}:${now}`,
        serviceId: result.id,
        title: `${result.name}: ${result.detail}`,
        level: result.level,
        stage: 'investigating',
        origin: 'probe',
        startedAt: new Date(streak.since).toISOString(),
        updatedAt: at,
        resolvedAt: null,
        url: null,
      });
    }
  }
  const oldest = historyDates(now)[0];
  const days = Object.fromEntries(Object.entries({ ...history.days, [date]: day }).filter(([d]) => d >= oldest));
  const kept = list.filter((i) => !i.resolvedAt || i.resolvedAt.slice(0, 10) >= oldest).slice(-MAX_INCIDENTS);
  return { history: { schemaVersion: 1, days, streaks }, incidents: kept };
}

export function serviceDays(history, id, now) {
  return historyDates(now).map((date) => {
    const entry = history.days?.[date]?.[id];
    const counts = entry?.counts ?? {};
    const checks = Object.values(counts).reduce((a, b) => a + b, 0);
    const failures = checks - (counts.operational ?? 0) - (counts.maintenance ?? 0) - (counts.unknown ?? 0);
    return { date, level: dayLevel(counts), checks, failures, notes: entry?.notes ?? [] };
  });
}

export function uptime(history, id, now) {
  let known = 0;
  let good = 0;
  for (const date of historyDates(now)) {
    const counts = history.days?.[date]?.[id]?.counts ?? {};
    for (const level of LEVELS) {
      if (level === 'unknown') continue;
      known += counts[level] ?? 0;
      if (healthy(level)) good += counts[level] ?? 0;
    }
  }
  return known === 0 ? null : Math.round((good / known) * 10000) / 100;
}

/** The banner: own services first, dependencies as a qualifier. */
export function headline(services, groups) {
  if (!services.length) return { level: 'unknown', title: 'Status unavailable', description: 'No checks have been published yet.' };
  const deps = new Set(groups.filter((g) => g.id === 'dependencies').map((g) => g.id));
  const trouble = (s) => ['degraded', 'partial_outage', 'major_outage'].includes(s.level);
  const own = services.filter((s) => !deps.has(s.group) && trouble(s));
  const upstream = services.filter((s) => deps.has(s.group) && trouble(s));
  if (!own.length && !upstream.length) {
    return { level: 'operational', title: 'All systems operational', description: `${services.length} services checked` };
  }
  if (!own.length) {
    return {
      level: 'degraded',
      title: 'SpecWeave is operational',
      description: `${upstream.map((s) => s.name).join(', ')} ${upstream.length === 1 ? 'reports' : 'report'} issues upstream.`,
    };
  }
  const all = [...own, ...upstream];
  return {
    level: rollup(all.map((s) => s.level)),
    title: `${all.length} service${all.length === 1 ? '' : 's'} need${all.length === 1 ? 's' : ''} attention`,
    description: all.map((s) => `${s.name}: ${LABELS[s.level]}`).join(' · '),
  };
}
