// Renders tools/og.html to site/og.png (1200x630), the social card.
// Needs playwright and a Chromium: `npx playwright install chromium` once, then
// `node tools/og.mjs`. Set CHROMIUM to reuse a browser you already have.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const src = new URL('./og.html', import.meta.url).href;
const out = fileURLToPath(new URL('../site/og.png', import.meta.url));

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(src, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
