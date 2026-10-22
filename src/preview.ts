import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VIEWPORT } from './config.js';

export interface PreviewMetrics {
  url: string;
  file: string;
  height: number;
  consoleErrors: string[];
  failedRequests: string[];
  brokenImages: string[];
  textNodes: number;
  imageCount: number;
}

export function previewUrl(store: string, handle: string, themeNumericId: string): string {
  return `https://${store}/products/${handle}?preview_theme_id=${themeNumericId}`;
}

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Dev stores sit behind the storefront password page; submit it once, then reload the target. */
export async function passStorefrontPassword(page: Page, target: string, password?: string): Promise<void> {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/\/password/.test(page.url())) {
    if (!password) throw new Error('The store is password protected. Set SHOPIFY_STORE_PASSWORD in .env.');
    await page.fill('input[type="password"]', password);
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.press('input[type="password"]', 'Enter')]);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (/\/password/.test(page.url())) throw new Error('The storefront password was rejected.');
  }
}

/** Screenshot the section at phone width after reveals, counters and images have settled. */
export async function capturePreview(opts: {
  url: string;
  outDir: string;
  tag: string;
  password?: string;
}): Promise<PreviewMetrics> {
  await mkdir(opts.outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA,
    });
    await context.addInitScript('window.__name = (f) => f;');
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    // Shopify's own platform assets (marketing fonts, payment widgets) sometimes fail on dev stores
    // and are not part of the section being checked.
    const platformNoise = /shopify-marketing_assets|\/shopifycloud\/|shop\.app|monorail|shopifysvc|\/cdn\/shop\/t\/\d+\/assets\/.*\.map/;
    page.on('console', (m) => {
      // "Failed to load resource" lines carry no URL; the request listeners below record them with one.
      if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
    page.on('requestfailed', (r) => {
      if (/image|font|stylesheet/.test(r.resourceType()) && !platformNoise.test(r.url())) {
        failedRequests.push(`${r.resourceType()} ${r.url().slice(0, 120)}`);
      }
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && /image|font|stylesheet/.test(r.request().resourceType()) && !platformNoise.test(r.url())) {
        failedRequests.push(`${r.status()} ${r.url().slice(0, 120)}`);
      }
    });

    await passStorefrontPassword(page, opts.url, opts.password);
    const root = page.locator('[data-nomore-root]').first();
    await root.waitFor({ state: 'attached', timeout: 30_000 });

    // Scroll through slowly so lazy images and scroll reveals fire.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(height, 7000); y += 350) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(3500); // counters run about 2 s
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          /* infinite animations cannot be finished */
        }
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    const stats = await root.evaluate((el) => {
      const imgs = Array.from(el.querySelectorAll('img'));
      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let texts = 0;
      while (walker.nextNode()) if ((walker.currentNode.textContent ?? '').trim()) texts++;
      return { broken, texts, images: imgs.length, height: Math.round(el.getBoundingClientRect().height) };
    });

    const file = path.join(opts.outDir, `preview-${opts.tag}.png`);
    await root.screenshot({ path: file });
    return {
      url: opts.url,
      file,
      height: stats.height,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
      failedRequests: [...new Set(failedRequests)].slice(0, 10),
      brokenImages: stats.broken.slice(0, 10),
      textNodes: stats.texts,
      imageCount: stats.images,
    };
  } finally {
    await browser.close();
  }
}

/** Final step of a run: open the page in a visible phone-size window and scroll it for the recording. */
export async function showOnPhone(url: string, password?: string, holdMs = 15_000): Promise<void> {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=430,900'] });
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA,
    });
    const page = await context.newPage();
    await passStorefrontPassword(page, url, password);
    await page.waitForTimeout(2500);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = Math.max(200, Math.floor(height / 24));
    for (let y = 0; y < height; y += step) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(holdMs);
  } finally {
    await browser.close();
  }
}
