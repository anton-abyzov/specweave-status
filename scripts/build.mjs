// Copies the static page and the latest data into dist/ for GitHub Pages.
import { cp, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
await mkdir('dist/data', { recursive: true });
await copyFile('config/services.json', 'dist/data/services.json');
const empty = { status: null, history: { schemaVersion: 1, days: {}, streaks: {} }, incidents: { schemaVersion: 1, incidents: [] } };
for (const [name, fallback] of Object.entries(empty)) {
  try { await copyFile(`data/${name}.json`, `dist/data/${name}.json`); }
  catch { if (fallback) await writeFile(`dist/data/${name}.json`, JSON.stringify(fallback)); }
}
await writeFile('dist/CNAME', 'status.spec-weave.com\n');
await writeFile('dist/.nojekyll', '');
console.log('Built dist/');
