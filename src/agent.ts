import { createSdkMcpServer, query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { SECTION_FILE } from './config.js';
import { connectShopify, themeNumericId } from './shopify.js';
import { previewUrl } from './preview.js';
import { buildTools, createState, GOOD_DIFF_PERCENT, MAX_WRITES, TOOL_NAMES, type RunState } from './tools.js';

const SERVER = 'nomore';
const MAX_TURNS = 40;

export const SYSTEM_PROMPT = `You rebuild the first three sections of a Shopify product landing page as ONE Liquid section for a theme, matching the original as closely as possible on a 390px phone screen.

You can only act through the nomore tools. Everything you need (copy, image URLs, styles, store state) comes from those tools. Never invent a URL, a headline or a number.

Hard requirements, enforced by a linter that rejects the upload:
1. One file: ${SECTION_FILE}. Markup, scoped CSS in a <style> block, small inline JS, and a {% schema %}.
2. No hardcoded content. Every visible string is a schema setting (text, textarea, richtext, inline_richtext) or block setting. Every image is an image_picker setting; give each one a text setting with the CDN URL as its fallback so the section renders before any upload. Alt text, link labels and aria-labels are settings too.
3. Repeating things (reviews, stats, bullets, benefits) are blocks with their own settings. Defaults live in presets[0] (settings and blocks), because the theme template is generated from it.
4. Wrap everything in an element with the attribute data-nomore-root and scope all CSS under it.
5. Fonts: load the original's Google fonts with a <link>. Colors, sizes and spacing may be CSS, but anything the merchant would reasonably want to change (colors, backgrounds) should also be a schema setting.
6. Mobile first. Match the original's spacing, type scale, colors and image sizes at 390px. Counters (such as the 0 to 100 percent band) animate once when scrolled into view; the final number is a setting.
7. The product behind the page is a plain placeholder (one product, one variant, one image), and the add to cart form simply posts that variant. Purchase logic stays simple, but the LOOK of the first section is rebuilt as the original shows it: gallery, title, rating, benefit list, the bundle cards with their labels and prices, buttons, badges. Those are editable blocks and text settings (a price on a card is a text setting, not the placeholder's price). Bundle cards may be selectable for show, but all of them add the placeholder variant.

Workflow:
1. inspect_source, get_theme_state, create_placeholder_product.
2. write_section with your first full version.
3. screenshot_preview, then compare_preview. Read the worst band and the strips, fix the largest visible differences (heights, font sizes, spacing, image crops, colors) and write_section again.
4. Stop when diffPercent is at or below ${GOOD_DIFF_PERCENT}, or after ${MAX_WRITES} uploads, whichever comes first. Do not chase pixels past that point.
5. Call verify_final once, then reply with a short summary: what you built, the final diff, anything that differs.

Be economical: read the screenshots carefully, change several things per upload, and never re-upload an unchanged file.`;

const USER_PROMPT = (url: string) =>
  `Rebuild the first 3 sections of ${url} as one editable Liquid section in the connected Shopify test store. Start with inspect_source.`;

/** Denies write_section once the cap is reached, so a stuck loop cannot burn budget. */
function writeCap(state: RunState): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !input.tool_name.endsWith('write_section')) return {};
    if (state.writes < MAX_WRITES) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Upload limit reached (${MAX_WRITES}). Call verify_final and finish.`,
      },
    };
  };
}

export interface RunResult {
  ok: boolean;
  costUsd: number;
  turns: number;
  subtype: string;
  previewUrl: string | null;
  state: RunState;
}

export async function runAgent(cfg: Config, outDir: string): Promise<RunResult> {
  await mkdir(outDir, { recursive: true });
  const shopify = await connectShopify(cfg);
  const state = createState(cfg, shopify, outDir);
  const server = createSdkMcpServer({ name: SERVER, version: '1.0.0', tools: buildTools(state) });

  const stream = query({
    prompt: USER_PROMPT(cfg.SOURCE_URL),
    options: {
      model: cfg.MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER]: server },
      // Only our seven tools exist: no shell, no file access, no web.
      tools: [],
      allowedTools: TOOL_NAMES.map((n) => `mcp__${SERVER}__${n}`),
      permissionMode: 'dontAsk',
      settingSources: [],
      maxTurns: MAX_TURNS,
      maxBudgetUsd: cfg.MAX_BUDGET_USD,
      persistSession: false,
      hooks: { PreToolUse: [{ matcher: `mcp__${SERVER}__write_section`, hooks: [writeCap(state)] }] },
    },
  });

  let costUsd = 0;
  let turns = 0;
  let subtype = 'unknown';
  let ok = false;

  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') console.log(`  -> ${block.name.replace(`mcp__${SERVER}__`, '')}`);
        else if (block.type === 'text' && block.text.trim()) console.log(`  ${block.text.trim().split('\n')[0]!.slice(0, 160)}`);
      }
    } else if (msg.type === 'result') {
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;
      subtype = msg.subtype;
      ok = msg.subtype === 'success' && !msg.is_error;
      if (msg.subtype === 'success') console.log(`\n${msg.result}`);
    }
  }

  const url =
    state.theme && state.productHandle
      ? previewUrl(cfg.SHOPIFY_STORE, state.productHandle, themeNumericId(state.theme.id))
      : null;
  return { ok, costUsd, turns, subtype, previewUrl: url, state };
}

export function outputDir(): string {
  return path.resolve('out');
}
