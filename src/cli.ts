import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { captureSource } from './source.js';
import { loadConfig } from './config.js';
import { outputDir, runAgent } from './agent.js';
import { showOnPhone } from './preview.js';

const cmd = process.argv[2];
const noPhone = process.argv.includes('--no-phone');

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env file: fall back to the real environment */
  }
}

async function extract(): Promise<void> {
  const url = process.env.SOURCE_URL ?? 'https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis';
  const cap = await captureSource(url, path.join(outputDir(), 'source'));
  console.log(`Captured ${cap.sections.length} sections, composite height ${cap.compositeHeight}px`);
  for (const s of cap.sections) {
    console.log(`  #${s.index + 1} ${s.id.split('__').pop()}  h=${s.height}  texts=${s.texts.length}  images=${s.images.length}`);
  }
  console.log(`fonts: ${cap.fonts.join(', ')}`);
  console.log(`product: ${cap.product.title} | ${cap.product.imageUrls.length} gallery images`);
}

async function run(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const out = outputDir();
  console.log(`Rebuilding ${cfg.SOURCE_URL}`);
  console.log(`Store: ${cfg.SHOPIFY_STORE} | model: ${cfg.MODEL} | budget cap: $${cfg.MAX_BUDGET_USD}`);
  console.log(`Auth: ${cfg.ANTHROPIC_API_KEY ? 'Anthropic API key' : 'Claude Code login (no API key set; cost below is an estimate)'}\n`);

  const result = await runAgent(cfg, out);

  const summary = {
    ok: result.ok,
    stop: result.subtype,
    turns: result.turns,
    uploads: result.state.writes,
    diffHistory: result.state.history,
    apiCostUsd: Number(result.costUsd.toFixed(4)),
    previewUrl: result.previewUrl,
  };
  await writeFile(path.join(out, 'run-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n----------------------------------------');
  console.log(`Result:        ${result.ok ? 'done' : `stopped early (${result.subtype})`}`);
  console.log(`Uploads:       ${result.state.writes}`);
  console.log(`Diff history:  ${result.state.history.map((h) => `${h.diffPercent}%`).join(' -> ') || 'n/a'}`);
  console.log(`API cost:      $${result.costUsd.toFixed(2)} (${result.turns} turns)`);
  console.log(`Section file:  out/nomore-landing.liquid`);
  console.log(`Preview:       ${result.previewUrl ?? 'n/a'}`);
  console.log('----------------------------------------');

  if (result.previewUrl && !noPhone) {
    console.log('\nOpening the page in a phone-size window...');
    await showOnPhone(result.previewUrl, cfg.SHOPIFY_STORE_PASSWORD);
  }
  if (!result.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (cmd === 'extract') return extract();
  if (cmd === 'run') return run();
  console.log('Usage: tsx src/cli.ts extract | run [--no-phone]');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
