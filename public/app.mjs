import { LABELS, headline, rollupKnown, serviceDays, uptime } from './model.mjs';

const STALE_MS = 45 * 60 * 1000;
const REFRESH_MS = 2 * 60 * 1000;
const STAGES = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
const $ = (selector) => document.querySelector(selector);
const expanded = new Set();
const collapsedGroups = new Set();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const chip = (level) => el('span', { class: 'chip', dataset: { level } }, LABELS[level]);
const dateLabel = (date) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const timeLabel = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
function age(iso, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}

async function getJson(path, fallback) {
  try {
    const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    return response.ok ? await response.json() : fallback;
  } catch {
    return fallback;
  }
}

function showPopover(bar, day, incidents) {
  const popover = $('#day-popover');
  const related = incidents.filter((i) => i.startedAt.slice(0, 10) <= day.date && (i.resolvedAt ?? '9999').slice(0, 10) >= day.date);
  popover.replaceChildren(
    el('div', { class: 'popover-head' }, el('span', {}, dateLabel(day.date)), chip(day.level)),
    el('p', {}, day.checks === 0 ? 'No checks recorded this day.' : day.failures === 0 ? `${day.checks} checks, all healthy.` : `${day.failures} of ${day.checks} checks found a problem.`),
    day.notes.length ? el('ul', {}, day.notes.map((note) => el('li', {}, note))) : null,
    related.length
      ? el('div', { class: 'related' }, el('strong', {}, 'Related incidents'), el('ul', {}, related.slice(0, 3).map((i) => el('li', {}, i.title))))
      : null,
  );
  popover.hidden = false;
  const rect = bar.getBoundingClientRect();
  const width = popover.offsetWidth;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), document.documentElement.clientWidth - width - 8);
  popover.style.left = `${left + scrollX}px`;
  popover.style.top = `${rect.top + scrollY - popover.offsetHeight - 10}px`;
  document.querySelectorAll('.bar.active').forEach((node) => node.classList.remove('active'));
  bar.classList.add('active');
}
function hidePopover() {
  $('#day-popover').hidden = true;
  document.querySelectorAll('.bar.active').forEach((node) => node.classList.remove('active'));
}

function dayBars(service, days, incidents) {
  const own = incidents.filter((i) => i.serviceId === service.id);
  let active = days.length - 1;
  const bars = days.map((day, index) =>
    el('span', { class: 'bar', dataset: { level: day.level, date: day.date }, onmouseenter: (event) => { active = index; showPopover(event.currentTarget, day, own); } }),
  );
  const strip = el(
    'div',
    {
      class: 'bars',
      role: 'group',
      tabindex: '0',
      'aria-label': `${service.name}: daily status for the last ${days.length} days. Use the arrow keys to read a day.`,
      onmouseleave: hidePopover,
      onblur: hidePopover,
      onfocus: () => showPopover(bars[active], days[active], own),
      onkeydown: (event) => {
        const moves = { ArrowLeft: -1, ArrowRight: 1 };
        if (event.key === 'Home') active = 0;
        else if (event.key === 'End') active = days.length - 1;
        else if (event.key in moves) active = Math.min(days.length - 1, Math.max(0, active + moves[event.key]));
        else return;
        event.preventDefault();
        showPopover(bars[active], days[active], own);
      },
    },
    bars,
  );
  return [strip, el('div', { class: 'bar-labels' }, el('span', {}, `${days.length} days ago`), el('span', {}, 'Today'))];
}

function serviceRow(definition, service, history, incidents, now, servicesById) {
  const days = serviceDays(history, definition.id, now);
  const percent = uptime(history, definition.id, now);
  const open = expanded.has(definition.id);
  const panelId = `panel-${definition.id}`;
  const dependsOn = (definition.dependsOn ?? []).map((id) => servicesById.get(id)).filter(Boolean);
  return el(
    'li',
    { class: 'service', dataset: { serviceId: definition.id } },
    el(
      'div',
      { class: 'service-head' },
      el(
        'button',
        {
          class: 'service-toggle',
          type: 'button',
          'aria-expanded': String(open),
          'aria-controls': panelId,
          onclick: () => { open ? expanded.delete(definition.id) : expanded.add(definition.id); render(); },
        },
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
        el('span', { class: 'grow' }, el('div', { class: 'service-name' }, definition.name), el('div', { class: 'service-detail' }, service?.detail ?? definition.description)),
      ),
      el('span', { class: 'uptime' }, percent === null ? 'No data yet' : `${percent >= 99.995 ? '100' : percent.toFixed(2)}% uptime`),
      chip(service?.level ?? 'unknown'),
    ),
    dayBars(definition, days, incidents),
    open
      ? el(
          'div',
          { class: 'panel', id: panelId },
          el('ul', {}, (service?.components ?? []).map((c) =>
            el('li', {}, el('div', {}, el('div', {}, c.name), c.detail ? el('div', { class: 'component-detail' }, c.detail) : null), chip(c.level)),
          )),
          dependsOn.length
            ? el('div', { class: 'panel-section' }, el('span', { class: 'muted' }, 'Depends on'),
                el('div', { class: 'tags' }, dependsOn.map((d) => el('span', { class: 'tag' }, `${d.name}: ${LABELS[d.level]}`))))
            : null,
          el('div', { class: 'panel-section' }, el('span', { class: 'muted' }, 'Used by'),
            el('div', { class: 'tags' }, (definition.usedBy ?? []).map((u) => el('span', { class: 'tag' }, u)))),
          definition.feed
            ? el('div', { class: 'panel-section muted' }, 'Source: ', el('a', { href: definition.feed.page, rel: 'noreferrer' }, new URL(definition.feed.page).host))
            : el('div', { class: 'panel-section muted' }, 'Source: checked from GitHub Actions every 10 minutes'),
        )
      : null,
  );
}

let state = null;

function render() {
  if (!state) return;
  const { config, status, history, incidents } = state;
  const now = Date.now();
  const services = status?.services ?? [];
  const byId = new Map(services.map((s) => [s.id, s]));
  const stale = status?.generatedAt ? now - Date.parse(status.generatedAt) > STALE_MS : true;
  const shown = config.services.map((d) => ({ ...d, level: byId.get(d.id)?.level ?? 'unknown' }));
  const head = headline(services.length ? shown : [], config.groups);

  const banner = $('#banner');
  banner.dataset.level = stale && services.length ? 'unknown' : head.level;
  $('#banner-title').textContent = head.title;
  $('#banner-description').textContent = head.description;
  $('#banner-age').textContent = status?.generatedAt
    ? `Last checked ${age(status.generatedAt, now)} · ${timeLabel(status.generatedAt)}${stale ? ' · checks are delayed; this may be out of date' : ''}`
    : 'The first check has not run yet.';

  const sorted = [...incidents].sort((a, b) => (!a.resolvedAt !== !b.resolvedAt ? (a.resolvedAt ? 1 : -1) : (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt)));
  const visible = [...sorted.filter((i) => !i.resolvedAt), ...sorted.filter((i) => i.resolvedAt).slice(0, 10)];
  $('#incidents').hidden = visible.length === 0;
  $('#incident-list').replaceChildren(...visible.map((i) =>
    el('li', { class: 'incident' },
      chip(i.resolvedAt ? 'operational' : i.level),
      el('div', { class: 'grow' },
        el('div', { class: 'incident-title' }, i.title),
        el('div', { class: 'incident-meta' },
          `${config.services.find((s) => s.id === i.serviceId)?.name ?? i.serviceId} · ${i.origin === 'upstream' ? 'Upstream status page' : 'Detected by our checks'} · ${i.resolvedAt ? `Resolved ${timeLabel(i.resolvedAt)}` : `Started ${timeLabel(i.startedAt)}`}`,
          i.url ? [' · ', el('a', { href: i.url, rel: 'noreferrer' }, 'Details')] : null)),
      el('span', { class: `stage${i.resolvedAt ? '' : ' open'}` }, STAGES[i.stage] ?? 'Investigating'))));

  $('#groups').replaceChildren(...config.groups.map((group) => {
    const members = config.services.filter((s) => s.group === group.id);
    const levels = members.map((m) => byId.get(m.id)?.level ?? 'unknown');
    const operational = levels.filter((l) => l === 'operational').length;
    const open = !collapsedGroups.has(group.id);
    return el('section', { class: 'card', dataset: { groupId: group.id } },
      el('button', {
        class: 'group-head', type: 'button', 'aria-expanded': String(open),
        onclick: () => { open ? collapsedGroups.add(group.id) : collapsedGroups.delete(group.id); render(); },
      },
        el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
        el('span', { class: 'grow' }, el('div', { class: 'group-name' }, group.name), el('div', { class: 'muted small' }, `${operational}/${members.length} operational · ${group.description}`)),
        chip(rollupKnown(levels))),
      open ? el('ul', { class: 'rows' }, members.map((m) => serviceRow(m, byId.get(m.id), history, incidents, now, new Map(shown.map((s) => [s.id, s]))))) : null);
  }));
  $('#main').setAttribute('aria-busy', 'false');
}

async function load() {
  const [config, status, history, incidents] = await Promise.all([
    getJson('data/services.json', null),
    getJson('data/status.json', null),
    getJson('data/history.json', { days: {} }),
    getJson('data/incidents.json', { incidents: [] }),
  ]);
  if (!config) {
    $('#banner-title').textContent = 'Status data could not be loaded';
    $('#banner-description').textContent = 'Refresh the page in a minute.';
    return;
  }
  if (!state) {
    // Services with trouble start expanded so their components are visible.
    for (const s of status?.services ?? []) if (!['operational', 'unknown'].includes(s.level)) expanded.add(s.id);
  }
  state = { config, status, history, incidents: incidents.incidents ?? [] };
  render();
}

const toggle = $('#theme-toggle');
const syncToggle = () => toggle.setAttribute('aria-label', `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} theme`);
toggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sw-status-theme', next); } catch {}
  syncToggle();
});
syncToggle();
addEventListener('scroll', hidePopover, { passive: true });
await load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
