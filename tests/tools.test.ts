import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Shopify } from '../src/shopify.js';
import { buildTools, createState, MAX_WRITES, TOOL_NAMES } from '../src/tools.js';

const good = readFileSync(new URL('./fixtures/good.liquid', import.meta.url), 'utf8');
const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key-123', SHOPIFY_STORE: 'dev-store.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_test_123' });

function setup() {
  const upserts: Array<{ filename: string; body: { value: string } }[]> = [];
  const impl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body));
    if (query.includes('themes(first')) {
      return new Response(JSON.stringify({ data: { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/77', name: 'Dawn', role: 'MAIN' }] } } }));
    }
    if (query.includes('themeFilesUpsert')) {
      upserts.push(variables.files);
      return new Response(JSON.stringify({ data: { themeFilesUpsert: { upsertedThemeFiles: variables.files.map((f: any) => ({ filename: f.filename })), userErrors: [] } } }));
    }
    return new Response(JSON.stringify({ data: {} }));
  }) as unknown as typeof fetch;
  const outDir = mkdtempSync(path.join(tmpdir(), 'nomore-'));
  const state = createState(cfg, new Shopify(cfg.SHOPIFY_STORE, cfg.SHOPIFY_ADMIN_TOKEN!, impl), outDir);
  const tools = Object.fromEntries(buildTools(state).map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await (tools[name] as any).handler(args, {});
    return { isError: !!r.isError, text: String(r.content?.[0]?.text ?? '') };
  };
  return { state, upserts, call, impl };
}

describe('agent tools', () => {
  it('exposes exactly the seven named tools', () => {
    const { state } = setup();
    expect(buildTools(state).map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('write_section rejects hardcoded content and uploads nothing', async () => {
    const { call, upserts, state } = setup();
    const bad = good.replace('<h1>{{ section.settings.heading }}</h1>', '<h1>Are you struggling with colds?</h1>');
    const r = await call('write_section', { liquid: bad });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Lint failed, nothing was uploaded/);
    expect(r.text).toMatch(/Hardcoded text/);
    expect(upserts).toHaveLength(0);
    expect(state.writes).toBe(0);
  });

  it('write_section uploads the section and a template generated from presets[0]', async () => {
    const { call, upserts, state } = setup();
    const r = await call('write_section', { liquid: good });
    expect(r.isError).toBe(false);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.map((f) => f.filename)).toEqual(['sections/nomore-landing.liquid', 'templates/product.nomore.json']);
    const template = JSON.parse(upserts[0]![1]!.body.value);
    expect(template.sections.main.block_order).toEqual(['review_1', 'review_2', 'stat_1']);
    expect(JSON.parse(r.text)).toMatchObject({ version: 1, writesLeft: MAX_WRITES - 1 });
    expect(state.writes).toBe(1);
  });

  it('screenshot_preview and compare_preview refuse to run out of order', async () => {
    const { call } = setup();
    expect((await call('screenshot_preview')).text).toMatch(/get_theme_state and create_placeholder_product first/);
    expect((await call('compare_preview')).isError).toBe(true);
  });

  it('compare_preview refuses a screenshot that is older than the last upload', async () => {
    const { call, state } = setup();
    await call('write_section', { liquid: good });
    state.lastPreview = { url: 'x', file: 'x.png', height: 1, consoleErrors: [], failedRequests: [], brokenImages: [], textNodes: 0, imageCount: 0 };
    state.previewVersion = 0; // screenshot was taken before upload 1
    const r = await call('compare_preview');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/upload 1 is live/);
  });

  it('verify_final fails honestly when nothing was built, and says why', async () => {
    const { call, state } = setup();
    const r = await call('verify_final');
    const report = JSON.parse(r.text);
    expect(report.pass).toBe(false);
    expect(report.withinTarget).toBe(false);
    expect(report.checks.filter((c: any) => !c.pass).length).toBeGreaterThan(0);
    expect(readFileSync(path.join(state.outDir, 'report.json'), 'utf8')).toContain('"pass": false');
  });
});
