# SpecWeave Status

Source of [status.spec-weave.com](https://status.spec-weave.com): live status of spec-weave.com, the `specweave` npm package, the Claude Code plugin, SpecWithCode downloads and updates, and the services they depend on (GitHub, Cloudflare, npm, Claude, OpenAI).

- `config/services.json`: groups, services, their checks or upstream status feeds, and what depends on each.
- `scripts/collect.mjs`: runs every check once and folds the result into `data/` (current status, 90 days of daily counts, incidents). Incidents open after two failed checks in a row and resolve after two healthy ones.
- `public/`: the static page (no build step, no dependencies). `public/model.mjs` is shared by the collector and the page.
- `.github/workflows/status.yml`: collects every 10 minutes, commits `data/`, and deploys to GitHub Pages.

Local: `npm test`, `node scripts/collect.mjs`, `node scripts/build.mjs`, then serve `dist/`. Headless page check: `PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/ui-check.mjs <screenshot-dir>`.
