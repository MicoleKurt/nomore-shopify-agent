import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Config,
  PLACEHOLDER_HANDLE,
  SECTION_FILE,
  TEMPLATE_FILE,
  TEMPLATE_SUFFIX,
} from './config.js';
import { captureSource, type SourceCapture } from './source.js';
import type { Shopify } from './shopify.js';
import { themeGid, themeNumericId, type Theme } from './shopify.js';
import { buildThemeWriter, type ThemeWriter } from './themeWriter.js';
import { lintSection, type LintResult } from './lint.js';
import { buildProductTemplate, stringifyTemplate } from './template.js';
import { capturePreview, previewUrl, type PreviewMetrics } from './preview.js';
import { compareImages, writeCompareArtifacts, type CompareResult } from './compare.js';

/** Target for "as close as possible on mobile": share of differing pixels in the composite. */
export const GOOD_DIFF_PERCENT = 8;
export const MAX_WRITES = 6;

export interface RunState {
  cfg: Config;
  shopify: Shopify;
  themeWriter: ThemeWriter;
  outDir: string;
  capture?: SourceCapture;
  theme?: Theme;
  productHandle?: string;
  section?: { source: string; lint: LintResult };
  writes: number;
  previews: number;
  lastPreview?: PreviewMetrics;
  /** The upload (state.writes) that lastPreview shows; guards against comparing a stale screenshot. */
  previewVersion?: number;
  lastCompare?: Omit<CompareResult, 'chunks' | 'diffPng'>;
  history: Array<{ write: number; diffPercent: number }>;
}

export function createState(cfg: Config, shopify: Shopify, outDir: string, themeWriter?: ThemeWriter): RunState {
  const writer =
    themeWriter ??
    buildThemeWriter(cfg.THEME_WRITER, {
      shopify,
      store: cfg.SHOPIFY_STORE,
      password: cfg.SHOPIFY_THEME_PASSWORD,
      workDir: path.join(outDir, 'theme-push'),
    });
  return { cfg, shopify, outDir, themeWriter: writer, writes: 0, previews: 0, history: [] };
}

type Content = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true as const });
const png = (buf: Buffer) => ({ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' });

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function ensureCapture(state: RunState): Promise<SourceCapture> {
  if (!state.capture) state.capture = await captureSource(state.cfg.SOURCE_URL, path.join(state.outDir, 'source'));
  return state.capture;
}

async function pickTheme(state: RunState): Promise<Theme> {
  if (state.theme) return state.theme;
  const themes = await state.shopify.listThemes();
  if (!themes.length) throw new Error('The store has no themes.');
  const wanted = state.cfg.SHOPIFY_THEME_ID;
  const theme = wanted
    ? themes.find((t) => themeNumericId(t.id) === wanted)
    : (themes.find((t) => t.role === 'MAIN') ?? themes[0]);
  if (!theme) throw new Error(`Theme ${wanted} was not found in the store.`);
  state.theme = theme;
  return theme;
}

export function buildTools(state: RunState) {
  const inspectSource = tool(
    'inspect_source',
    'Load the original landing page at 390px (phone) and return its first 3 content sections: texts with computed styles, image URLs and sizes, cleaned HTML, fonts, and a screenshot of each section. This is the only source of copy and URLs.',
    {},
    async () => {
      try {
        const cap = await ensureCapture(state);
        const brief = {
          url: cap.url,
          viewport: cap.viewport,
          compositeHeightPx: cap.compositeHeight,
          fonts: cap.fonts,
          productImageUrls: cap.product.imageUrls,
          sections: cap.sections.map((s) => ({
            index: s.index + 1,
            id: s.id.split('__').pop(),
            heightPx: s.height,
            background: s.background,
            texts: s.texts.slice(0, 70),
            images: s.images.slice(0, 40),
            cleanHtml: s.cleanHtml,
          })),
        };
        const content: Content = [{ type: 'text', text: JSON.stringify(brief) }];
        for (const s of cap.sections) {
          content.push({ type: 'text', text: `Screenshot of section ${s.index + 1} (${s.height}px tall):` });
          content.push(png(await readFile(s.screenshot)));
        }
        return { content };
      } catch (e) {
        return fail(`inspect_source failed: ${message(e)}`);
      }
    },
  );

  const getThemeState = tool(
    'get_theme_state',
    'List the store themes, choose the theme to work in, and report whether the section and template files already exist.',
    {},
    async () => {
      try {
        const theme = await pickTheme(state);
        const files = await state.shopify.readThemeFiles(theme.id, [SECTION_FILE, TEMPLATE_FILE, 'layout/theme.liquid']);
        return text(
          JSON.stringify({
            theme: { id: themeNumericId(theme.id), name: theme.name, role: theme.role },
            sectionFile: SECTION_FILE,
            templateFile: TEMPLATE_FILE,
            sectionExists: files[SECTION_FILE] !== null,
            templateExists: files[TEMPLATE_FILE] !== null,
            layoutExists: files['layout/theme.liquid'] !== null,
          }),
        );
      } catch (e) {
        return fail(`get_theme_state failed: ${message(e)}`);
      }
    },
  );

  const createPlaceholderProduct = tool(
    'create_placeholder_product',
    'Create or update the simple placeholder product (one variant, one image) that the page renders for. Idempotent: the same handle never duplicates.',
    {},
    async () => {
      try {
        const cap = await ensureCapture(state);
        const p = await state.shopify.upsertPlaceholderProduct({
          handle: PLACEHOLDER_HANDLE,
          title: cap.product.title,
          price: '29.95',
          imageUrl: cap.product.imageUrls[0]!,
          templateSuffix: TEMPLATE_SUFFIX,
        });
        state.productHandle = p.handle;
        return text(JSON.stringify({ handle: p.handle, id: p.id, templateSuffix: p.templateSuffix, mediaCount: p.mediaCount }));
      } catch (e) {
        return fail(`create_placeholder_product failed: ${message(e)}`);
      }
    },
  );

  const writeSection = tool(
    'write_section',
    `Validate and upload the complete Liquid section file (markup, scoped CSS, small inline JS and the {% schema %}). The server lints it first: no hardcoded text, URLs or attributes; every setting used must exist; presets[0] must hold the default content. It also generates ${TEMPLATE_FILE} from the preset. Rejects with the exact errors if lint fails.`,
    { liquid: z.string().min(200).describe('The entire contents of the section file') },
    async ({ liquid }) => {
      try {
        const theme = await pickTheme(state);
        const lint = lintSection(liquid);
        if (!lint.ok || !lint.schema) {
          return fail(`Lint failed, nothing was uploaded:\n- ${lint.errors.join('\n- ')}`);
        }
        const template = stringifyTemplate(buildProductTemplate(lint.schema, 'nomore-landing'));
        await state.themeWriter.upsert(theme, [
          { filename: SECTION_FILE, content: liquid },
          { filename: TEMPLATE_FILE, content: template },
        ]);
        state.writes += 1;
        state.section = { source: liquid, lint };
        await mkdir(state.outDir, { recursive: true });
        await writeFile(path.join(state.outDir, `section-v${state.writes}.liquid`), liquid);
        await writeFile(path.join(state.outDir, 'nomore-landing.liquid'), liquid);
        return text(
          JSON.stringify({
            uploaded: [SECTION_FILE, TEMPLATE_FILE],
            via: state.themeWriter.name,
            version: state.writes,
            writesLeft: MAX_WRITES - state.writes,
            warnings: lint.warnings,
          }),
        );
      } catch (e) {
        return fail(`write_section failed: ${message(e)}`);
      }
    },
  );

  const screenshotPreview = tool(
    'screenshot_preview',
    'Open the uploaded section in the store preview at 390px, wait for images, reveals and counters, and screenshot it. Returns console errors, failed requests and broken images.',
    {},
    async () => {
      try {
        if (!state.theme || !state.productHandle) return fail('Run get_theme_state and create_placeholder_product first.');
        if (!state.section) return fail('Nothing uploaded yet. Call write_section first.');
        state.previews += 1;
        const metrics = await capturePreview({
          url: previewUrl(state.cfg.SHOPIFY_STORE, state.productHandle, themeNumericId(state.theme.id)),
          outDir: path.join(state.outDir, 'preview'),
          tag: String(state.previews),
          password: state.cfg.SHOPIFY_STORE_PASSWORD,
        });
        state.lastPreview = metrics;
        state.previewVersion = state.writes;
        return text(JSON.stringify({ ...metrics, file: undefined, version: state.writes }));
      } catch (e) {
        return fail(`screenshot_preview failed: ${message(e)}`);
      }
    },
  );

  const comparePreview = tool(
    'compare_preview',
    'Pixel-compare the latest preview against the original composite of the first 3 sections. Returns the diff percent, height difference, the worst 300px band, and side-by-side strips (original | yours | diff).',
    {},
    async () => {
      try {
        if (!state.lastPreview) return fail('Call screenshot_preview first.');
        if (state.previewVersion !== state.writes) {
          return fail(`The screenshot shows upload ${state.previewVersion}, but upload ${state.writes} is live. Call screenshot_preview again.`);
        }
        const cap = await ensureCapture(state);
        const result = compareImages(await readFile(cap.composite), await readFile(state.lastPreview.file));
        const files = await writeCompareArtifacts(result, path.join(state.outDir, 'preview'), `v${state.writes}`);
        const { chunks, diffPng, ...summary } = result;
        void diffPng;
        state.lastCompare = summary;
        state.history.push({ write: state.writes, diffPercent: summary.diffPercent });
        const content: Content = [
          {
            type: 'text',
            text: JSON.stringify({
              version: state.writes,
              target: `diffPercent <= ${GOOD_DIFF_PERCENT}`,
              originalHeight: summary.originalHeight,
              previewHeight: summary.previewHeight,
              heightDelta: summary.heightDelta,
              diffPercent: summary.diffPercent,
              worstBand: summary.worstBand,
              bands: summary.bands,
              history: state.history,
              artifacts: files,
            }),
          },
        ];
        for (const c of chunks.slice(0, 3)) content.push(png(c));
        return { content };
      } catch (e) {
        return fail(`compare_preview failed: ${message(e)}`);
      }
    },
  );

  const verifyFinal = tool(
    'verify_final',
    'Run the final checks and write out/report.json: lint passes, no console errors, no broken images, text and images exist, and the diff is within target. Call this last.',
    {},
    async () => {
      try {
        const checks: Array<{ name: string; pass: boolean; detail: string; soft?: boolean }> = [];
        const lint = state.section ? lintSection(state.section.source) : undefined;
        checks.push({ name: 'lint passes (no hardcoded content)', pass: !!lint?.ok, detail: lint ? lint.errors.join('; ') || 'ok' : 'no section written' });
        const p = state.lastPreview;
        checks.push({
          name: 'preview shows the latest upload',
          pass: !!p && state.previewVersion === state.writes && state.lastCompare !== undefined && state.history.at(-1)?.write === state.writes,
          detail: p ? `${p.height}px tall, preview of upload ${state.previewVersion}, ${state.writes} uploaded` : 'no preview',
        });
        checks.push({ name: 'no console errors', pass: !!p && p.consoleErrors.length === 0, detail: p?.consoleErrors.join(' | ') || 'none' });
        checks.push({ name: 'no broken images', pass: !!p && p.brokenImages.length === 0 && p.failedRequests.length === 0, detail: [...(p?.brokenImages ?? []), ...(p?.failedRequests ?? [])].join(' | ') || 'none' });
        // Expected content comes from the captured original, not from a hardcoded guess.
        const wantTexts = Math.floor((state.capture?.sections.reduce((n, s) => n + s.texts.length, 0) ?? 0) * 0.5);
        const wantImages = Math.floor((state.capture?.sections.reduce((n, s) => n + s.images.length, 0) ?? 0) * 0.6);
        checks.push({
          name: 'content present',
          pass: !!p && p.textNodes >= wantTexts && p.imageCount >= wantImages,
          detail: p ? `${p.textNodes} text nodes (need ${wantTexts}), ${p.imageCount} images (need ${wantImages})` : 'no preview',
        });
        const c = state.lastCompare;
        checks.push({
          name: `mobile diff <= ${GOOD_DIFF_PERCENT}%`,
          pass: !!c && c.diffPercent <= GOOD_DIFF_PERCENT,
          detail: c ? `${c.diffPercent}% (height delta ${c.heightDelta}px)` : 'not compared',
          soft: true, // reported, but a clean render slightly above target is not a failed run
        });
        const pass = checks.filter((x) => !x.soft).every((x) => x.pass);
        const report = {
          pass,
          withinTarget: checks.filter((x) => x.soft).every((x) => x.pass),
          store: state.cfg.SHOPIFY_STORE,
          theme: state.theme ? themeNumericId(state.theme.id) : null,
          product: state.productHandle,
          writes: state.writes,
          diffHistory: state.history,
          checks,
          previewUrl:
            state.theme && state.productHandle
              ? previewUrl(state.cfg.SHOPIFY_STORE, state.productHandle, themeNumericId(state.theme.id))
              : null,
        };
        await writeFile(path.join(state.outDir, 'report.json'), JSON.stringify(report, null, 2));
        return text(JSON.stringify(report));
      } catch (e) {
        return fail(`verify_final failed: ${message(e)}`);
      }
    },
  );

  return [inspectSource, getThemeState, createPlaceholderProduct, writeSection, screenshotPreview, comparePreview, verifyFinal];
}

export const TOOL_NAMES = [
  'inspect_source',
  'get_theme_state',
  'create_placeholder_product',
  'write_section',
  'screenshot_preview',
  'compare_preview',
  'verify_final',
] as const;

export { themeGid };
