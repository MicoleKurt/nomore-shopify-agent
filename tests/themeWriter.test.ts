import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Theme } from '../src/shopify.js';
import {
  CliThemeWriter,
  FallbackThemeWriter,
  quoteArg,
  type Runner,
  type ThemeFile,
  type ThemeWriter,
} from '../src/themeWriter.js';

const files: ThemeFile[] = [
  { filename: 'sections/nomore-landing.liquid', content: '<div data-nomore-root></div>' },
  { filename: 'templates/product.nomore.json', content: '{}' },
];
const unpublished: Theme = { id: 'gid://shopify/OnlineStoreTheme/55', name: 'Test', role: 'UNPUBLISHED' };
const live: Theme = { id: 'gid://shopify/OnlineStoreTheme/77', name: 'Dawn', role: 'MAIN' };

function runner(results: Array<{ code: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ commandLine: string; env: NodeJS.ProcessEnv }> = [];
  const run: Runner = async (commandLine, env) => {
    calls.push({ commandLine, env });
    const r = results.shift() ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

describe('CliThemeWriter', () => {
  it('writes the files locally and pushes only those files, without deleting anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run, calls } = runner([{ code: 0 }, { code: 0 }]); // version probe, then push
    await new CliThemeWriter('dev.myshopify.com', 'shptka_secretpass', dir, run).upsert(unpublished, files);

    expect(readFileSync(path.join(dir, 'sections', 'nomore-landing.liquid'), 'utf8')).toBe(files[0]!.content);
    const push = calls[1]!.commandLine;
    expect(push).toMatch(/^shopify theme push /);
    expect(push).toContain('--store dev.myshopify.com');
    expect(push).toContain('--theme 55');
    expect(push).toContain('--only sections/nomore-landing.liquid');
    expect(push).toContain('--only templates/product.nomore.json');
    expect(push).toContain('--nodelete');
    expect(push).toContain('--no-input');
    expect(push).not.toContain('--allow-live');
  });

  it('keeps the password out of the command line and puts it in the environment', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run, calls } = runner([{ code: 0 }, { code: 0 }]);
    await new CliThemeWriter('dev.myshopify.com', 'shptka_secretpass', dir, run).upsert(unpublished, files);
    expect(calls[1]!.commandLine).not.toContain('shptka_secretpass');
    expect(calls[1]!.env.SHOPIFY_CLI_THEME_TOKEN).toBe('shptka_secretpass');
  });

  it('allows pushing to the live theme only when the target really is the live theme', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run, calls } = runner([{ code: 0 }, { code: 0 }]);
    await new CliThemeWriter('dev.myshopify.com', undefined, dir, run).upsert(live, files);
    expect(calls[1]!.commandLine).toContain('--allow-live');
  });

  it('falls back to npx when no global shopify CLI exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run, calls } = runner([{ code: 1 }, { code: 0 }]);
    await new CliThemeWriter('dev.myshopify.com', undefined, dir, run).upsert(unpublished, files);
    expect(calls[1]!.commandLine).toMatch(/^npx --yes @shopify\/cli@latest theme push /);
  });

  it('reports a failed push without leaking the password', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run } = runner([{ code: 0 }, { code: 1, stderr: 'Invalid password shptka_secretpass for store' }]);
    const err = await new CliThemeWriter('dev.myshopify.com', 'shptka_secretpass', dir, run).upsert(unpublished, files).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/theme push failed \(exit 1\)/);
    expect((err as Error).message).not.toContain('shptka_secretpass');
    expect((err as Error).message).toContain('***');
  });

  it('tells the user how to log in when there is no password', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
    const { run } = runner([{ code: 0 }, { code: 1, stderr: 'login required' }]);
    await expect(new CliThemeWriter('dev.myshopify.com', undefined, dir, run).upsert(unpublished, files)).rejects.toThrow(/SHOPIFY_THEME_PASSWORD/);
  });
});

describe('FallbackThemeWriter', () => {
  const writer = (impl: () => Promise<void>, name = 'w'): ThemeWriter & { upsert: ReturnType<typeof vi.fn> } => ({
    name,
    upsert: vi.fn(impl),
  });

  it('uses the primary route when it works', async () => {
    const primary = writer(async () => {});
    const fallback = writer(async () => {});
    await new FallbackThemeWriter(primary, fallback, () => {}).upsert(unpublished, files);
    expect(primary.upsert).toHaveBeenCalledTimes(1);
    expect(fallback.upsert).not.toHaveBeenCalled();
  });

  it('switches to the CLI when Shopify refuses theme writes, and stays there', async () => {
    const log = vi.fn();
    const primary = writer(async () => {
      throw new Error('Access denied for themeFilesUpsert field. Required access: write_themes access scope.');
    }, 'admin');
    const fallback = writer(async () => {}, 'cli');
    const w = new FallbackThemeWriter(primary, fallback, log);
    await w.upsert(unpublished, files);
    await w.upsert(unpublished, files);
    expect(primary.upsert).toHaveBeenCalledTimes(1); // not retried on the second upload
    expect(fallback.upsert).toHaveBeenCalledTimes(2);
    expect(w.name).toBe('cli');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not hide a real error such as a Liquid syntax problem behind the fallback', async () => {
    const primary = writer(async () => {
      throw new Error('sections/nomore-landing.liquid: Liquid syntax error (line 12): Unknown tag');
    });
    const fallback = writer(async () => {});
    await expect(new FallbackThemeWriter(primary, fallback, () => {}).upsert(unpublished, files)).rejects.toThrow(/Liquid syntax error/);
    expect(fallback.upsert).not.toHaveBeenCalled();
  });
});

describe('quoteArg', () => {
  it('leaves simple arguments alone', () => {
    expect(quoteArg('sections/nomore-landing.liquid')).toBe('sections/nomore-landing.liquid');
    expect(quoteArg('dev-store.myshopify.com')).toBe('dev-store.myshopify.com');
  });
  it('quotes paths with spaces and escapes quotes', () => {
    expect(quoteArg('C:\\My Work\\out')).toBe('"C:\\My Work\\out"');
    expect(quoteArg('a"b c')).toBe('"a\\"b c"');
  });
});
