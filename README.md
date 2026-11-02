# SpecWeave Status

Source of [status.spec-weave.com](https://status.spec-weave.com): live status of SpecWithCode (Connect relay, sign-in, website and docs, downloads, updates), vskill (verified-skill.com, its API, the skill registry, crawl workers), the SpecWeave CLI (npm package, Claude Code plugin), and the providers they run on (GitHub, Cloudflare, npm, Claude, OpenAI).

- `config/services.json`: groups, services, their checks or upstream status feeds, and what depends on each.
- Crawl worker health URLs come from the `CRAWL_WORKER_URLS` repo secret (comma-separated), so the public config and page never show their addresses.
- `scripts/collect.mjs`: runs every check once and folds the result into `data/` (current status, 90 days of daily counts, incidents). Incidents open after two failed checks in a row and resolve after two healthy ones.
- `public/`: the static page (no build step, no dependencies). `public/model.mjs` is shared by the collector and the page.
- `.github/workflows/status.yml`: collects every 10 minutes, commits `data/`, and deploys to GitHub Pages.

Local: `npm test`, `node scripts/collect.mjs`, `node scripts/build.mjs`, then serve `dist/`. Headless page check: `PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/ui-check.mjs <screenshot-dir>`.
