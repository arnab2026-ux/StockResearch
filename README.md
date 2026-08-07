# StockResearch

Stock research platform focused on US equities with real-time data.

## Status

Scaffolding only — data pipeline and UI not yet built. Scraping/automation
dependencies are installed and verified.

## Stack

- **Node 24 + TypeScript** (ESM, strict)
- **[Firecrawl](https://www.firecrawl.dev)** — hosted scraping/extraction API
- **[Playwright](https://playwright.dev)** — browser automation (Chromium installed)
- **tsx** — direct TypeScript execution

## Setup

```bash
npm install
npx playwright install chromium
```

Copy the env template and add your Firecrawl key:

```bash
cp .env.example .env
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run smoke` | Verify Playwright launches and the Firecrawl SDK loads |
| `npm run typecheck` | Type-check without emitting |

`npm run smoke` skips the live Firecrawl call when `FIRECRAWL_API_KEY` is unset.
