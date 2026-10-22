import { chromium, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIEWPORT } from './config.js';

export interface TextItem {
  tag: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  font: string;
  size: string;
  weight: string;
  color: string;
  lineHeight: string;
  align: string;
  letterSpacing: string;
  transform: string;
}

export interface ImageItem {
  src: string;
  alt: string;
  x: number;
  y: number;
  w: number;
  h: number;
  naturalW: number;
  naturalH: number;
}

type TextItemRaw = TextItem;

export interface SectionBrief {
  index: number;
  id: string;
  top: number;
  height: number;
  background: string;
  paddingTop: string;
  paddingBottom: string;
  cleanHtml: string;
  texts: TextItem[];
  images: ImageItem[];
  screenshot: string;
}

export interface SourceCapture {
  url: string;
  viewport: typeof VIEWPORT;
  fonts: string[];
  product: { title: string; handle: string; imageUrls: string[] };
  sections: SectionBrief[];
  composite: string;
  compositeHeight: number;
}

/** Prefix protocol-relative CDN URLs ("//cdn.shopify.com/...") with https. */
export function absoluteUrl(src: string, base = 'https://try-nomore.com'): string {
  if (!src) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return new URL(src, base).toString();
  return src;
}

export async function prepare(page: Page): Promise<void> {
  // Remove fixed overlays (cookie bars, popups, chat widgets) so they never cover a section.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const s = getComputedStyle(el);
      if (s.position === 'fixed' && !el.closest('header') && el.getBoundingClientRect().height > 40) el.remove();
    }
  });
  // Scroll slowly so scroll-triggered reveals fire and lazy images load, then let the reveals finish.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(height, 7000); y += 350) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        /* infinite animations cannot be finished; leave them */
      }
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

export async function captureSource(url: string, outDir: string, count = 3): Promise<SourceCapture> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    // tsx/esbuild wraps named functions in __name(); define it so evaluate() callbacks run in the page.
    await context.addInitScript('window.__name = (f) => f;');
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await prepare(page);

    const raw = await page.evaluate((n) => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.height > 60 && r.width > 100 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const all = Array.from(document.querySelectorAll<HTMLElement>('.shopify-section')).filter(
        (el) => !el.closest('header, footer') && !/header|footer|announcement/i.test(el.id) && visible(el),
      );
      const picked = all.slice(0, n);
      const abs = (v: string) => (v.startsWith('//') ? `https:${v}` : v);
      const out = picked.map((el, index) => {
        const box = el.getBoundingClientRect();
        const top = box.top + window.scrollY;
        const cs = getComputedStyle(el);
        const texts: TextItemRaw[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const seen = new Set<Element>();
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const parent = node.parentElement;
          const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!parent || !value || seen.has(parent) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
          const r = parent.getBoundingClientRect();
          const p = getComputedStyle(parent);
          if (r.height < 2 || p.display === 'none' || p.visibility === 'hidden') continue;
          seen.add(parent);
          texts.push({
            tag: parent.tagName.toLowerCase(),
            text: (parent.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
            x: Math.round(r.left - box.left),
            y: Math.round(r.top - box.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
            font: p.fontFamily,
            size: p.fontSize,
            weight: p.fontWeight,
            color: p.color,
            lineHeight: p.lineHeight,
            align: p.textAlign,
            letterSpacing: p.letterSpacing,
            transform: p.textTransform,
          });
        }
        const images = Array.from(el.querySelectorAll('img'))
          .map((img) => {
            const r = img.getBoundingClientRect();
            return {
              src: abs(img.currentSrc || img.getAttribute('src') || ''),
              alt: img.alt || '',
              x: Math.round(r.left - box.left),
              y: Math.round(r.top - box.top),
              w: Math.round(r.width),
              h: Math.round(r.height),
              naturalW: img.naturalWidth,
              naturalH: img.naturalHeight,
            };
          })
          .filter((i) => i.src && i.w > 2 && i.h > 2);
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, svg, link, template, iframe').forEach((n) => n.remove());
        const keep = new Set(['class', 'id', 'style', 'src', 'alt', 'href', 'role']);
        clone.querySelectorAll('*').forEach((n) => {
          for (const a of Array.from(n.attributes)) if (!keep.has(a.name)) n.removeAttribute(a.name);
          const src = n.getAttribute('src');
          if (src && src.startsWith('data:')) n.removeAttribute('src');
        });
        const cleanHtml = clone.outerHTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').slice(0, 20000);
        return {
          index,
          id: el.id,
          cleanHtml,
          top: Math.round(top),
          height: Math.round(box.height),
          background: cs.backgroundColor,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          texts: texts.slice(0, 90),
          images: images.slice(0, 60),
        };
      });
      const fonts = Array.from(new Set(Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))));
      return { out, fonts };
    }, count);

    if (raw.out.length < count) throw new Error(`Found only ${raw.out.length} content sections on ${url}`);

    const sections: SectionBrief[] = [];
    for (const s of raw.out) {
      const file = path.join(outDir, `source-section-${s.index + 1}.png`);
      await page.locator(`[id="${s.id}"]`).screenshot({ path: file });
      sections.push({ ...s, screenshot: file });
    }

    const first = raw.out[0]!;
    const last = raw.out[raw.out.length - 1]!;
    const compositeHeight = last.top + last.height - first.top;
    const composite = path.join(outDir, 'source-composite.png');
    await page.screenshot({
      path: composite,
      fullPage: true,
      clip: { x: 0, y: first.top, width: VIEWPORT.width, height: compositeHeight },
    });

    const product = await fetchProductJson(url);
    const capture: SourceCapture = {
      url,
      viewport: VIEWPORT,
      fonts: raw.fonts,
      product,
      sections,
      composite,
      compositeHeight,
    };
    await writeFile(path.join(outDir, 'source-brief.json'), JSON.stringify(capture, null, 2));
    return capture;
  } finally {
    await browser.close();
  }
}

/** The storefront serves every product as JSON at "<product url>.js". No DOM scraping. */
export async function fetchProductJson(url: string): Promise<SourceCapture['product']> {
  const res = await fetch(`${url.replace(/\/$/, '')}.js`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Product JSON request failed: ${res.status}`);
  const data = (await res.json()) as {
    title: string;
    handle: string;
    images: string[];
  };
  // The .js endpoint reports prices in the store's base currency, not the one shown to visitors,
  // so no price is taken from it: the prices on the page are read from the rendered text instead.
  return {
    title: data.title,
    handle: data.handle,
    imageUrls: data.images.map((i) => absoluteUrl(i)),
  };
}
