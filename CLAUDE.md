# StockResearch

Stock research platform for **US equities**, intended to work from real-time data.

## Repo isolation

This project is completely separate from the `cleartax` repo (an Indian
income-tax filing app that lives at `C:\cleartax` → `arnab2026-ux/cleartax`).
Never move code between the two. Nothing here goes there, and nothing there
comes here.

## Stack

Node 24, TypeScript 7 (ESM, `strict` + `noUncheckedIndexedAccess`), run via
`tsx`. No framework or UI chosen yet.

| Package | Purpose |
| --- | --- |
| `firecrawl` 4.32 | Hosted scraping / extraction API |
| `playwright` 1.62 | Browser automation (Chromium only) |
| `dotenv` | Env loading |

## Setup on a fresh machine

```bash
npm install
npx playwright install chromium
```

The Chromium binary lives in the OS-level Playwright cache, **not** in this
repo — `npm install` alone will not fetch it, and Playwright will fail at
launch until the second command runs. This matters for cloud sessions and CI.

Secrets go in `.env` (gitignored); `.env.example` lists the keys. Only the user
adds real key values.

## Verifying the toolchain

```bash
npm run smoke
```

Launches Chromium and loads the Firecrawl SDK. The live Firecrawl call is
skipped when `FIRECRAWL_API_KEY` is unset, so a pass without a key only proves
Playwright works.

## Firecrawl SDK — do not write this from memory

The package was renamed; most examples online and in training data are stale.

- Package is `firecrawl`, **not** `@mendable/firecrawl-js` (legacy alias).
- Default export is the `Firecrawl` class: `new Firecrawl({ apiKey })`.
- `scrape(url, options)` returns a `Document`; ask for output via
  `{ formats: ["markdown"] }`.

Check `node_modules/firecrawl/dist/index.d.ts` before using any other method.

## Open decision: where real-time prices come from

Firecrawl and Playwright are **page scrapers** and cannot deliver real-time
quotes — expect delayed data, brittle selectors, and rate limits, and most
financial sites' terms prohibit scraping quotes.

Recommended split, not yet agreed with the user:

- **Prices / quotes** — a market data API (Polygon, Alpaca, Finnhub, Tiingo;
  several have free tiers).
- **Qualitative research** — Firecrawl and Playwright are a good fit here:
  filings, earnings transcripts, news, analyst commentary.

Confirm this with the user before building any data ingestion.

## Conventions

- Never commit `.env` or any API key.
- Keep `npm run typecheck` clean.
