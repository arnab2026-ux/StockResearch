import "dotenv/config";
import Firecrawl from "firecrawl";
import { chromium } from "playwright";

async function checkPlaywright(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>ok</h1>");
    const heading = await page.textContent("h1");
    if (heading !== "ok") {
      throw new Error(`unexpected page content: ${heading}`);
    }
    console.log(`playwright: chromium ${browser.version()} launched and rendered`);
  } finally {
    await browser.close();
  }
}

async function checkFirecrawl(): Promise<void> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.log("firecrawl: SDK loaded, no FIRECRAWL_API_KEY set — skipping live call");
    return;
  }

  const firecrawl = new Firecrawl({ apiKey });
  const doc = await firecrawl.scrape("https://example.com", { formats: ["markdown"] });
  console.log(`firecrawl: scraped example.com, ${doc.markdown?.length ?? 0} chars of markdown`);
}

await checkPlaywright();
await checkFirecrawl();
