import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Shopify, Theme } from './shopify.js';

export interface ThemeFile {
  filename: string;
  content: string;
}

/** Where uploaded theme files go. Two routes exist because Shopify gates theme-file writes. */
export interface ThemeWriter {
  readonly name: string;
  upsert(theme: Theme, files: ThemeFile[]): Promise<void>;
}

/** Admin GraphQL themeFilesUpsert. Needs write_themes, which Shopify only grants to exempted apps. */
export class AdminApiThemeWriter implements ThemeWriter {
  readonly name = 'Admin API (themeFilesUpsert)';
  constructor(private readonly shopify: Shopify) {}

  async upsert(theme: Theme, files: ThemeFile[]): Promise<void> {
    await this.shopify.upsertThemeFiles(theme.id, files);
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (commandLine: string, env: NodeJS.ProcessEnv) => Promise<RunResult>;

export const spawnRunner: Runner = (commandLine, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(commandLine, { shell: true, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Quote one shell argument for cmd.exe and POSIX shells alike. */
export function quoteArg(arg: string): string {
  return /^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * `shopify theme push` for exactly the files given. It signs in as a staff user or with a Theme Access
 * password, so it does not need the write_themes exemption the Admin API route needs.
 */
export class CliThemeWriter implements ThemeWriter {
  readonly name = 'Shopify CLI (theme push)';
  private bin: string | undefined;

  constructor(
    private readonly store: string,
    private readonly password: string | undefined,
    private readonly workDir: string,
    private readonly run: Runner = spawnRunner,
  ) {}

  /** Use a global `shopify` when there is one, otherwise let npx fetch the CLI. */
  private async resolveBin(): Promise<string> {
    if (this.bin) return this.bin;
    const probe = await this.run('shopify version', process.env).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    this.bin = probe.code === 0 ? 'shopify' : 'npx --yes @shopify/cli@latest';
    return this.bin;
  }

  async upsert(theme: Theme, files: ThemeFile[]): Promise<void> {
    for (const f of files) {
      const target = path.join(this.workDir, f.filename);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.content);
    }
    const themeId = /(\d+)$/.exec(theme.id)?.[1];
    if (!themeId) throw new Error(`Unexpected theme id: ${theme.id}`);

    const args = [
      'theme', 'push',
      '--store', this.store,
      '--theme', themeId,
      '--path', this.workDir,
      ...files.flatMap((f) => ['--only', f.filename]),
      '--nodelete', // never remove the rest of the theme
      '--no-input',
      '--no-color',
      ...(theme.role === 'MAIN' ? ['--allow-live'] : []),
    ];
    const commandLine = `${await this.resolveBin()} ${args.map(quoteArg).join(' ')}`;
    // The password travels in the environment, not on the command line.
    const env = { ...process.env, ...(this.password ? { SHOPIFY_CLI_THEME_TOKEN: this.password } : {}) };
    const res = await this.run(commandLine, env);
    if (res.code !== 0) {
      const raw = `${res.stderr}\n${res.stdout}`;
      const detail = (this.password ? raw.split(this.password).join('***') : raw).trim().split('\n').slice(-8).join('\n');
      throw new Error(
        `shopify theme push failed (exit ${res.code}). ${
          this.password ? '' : 'No SHOPIFY_THEME_PASSWORD was set, so the CLI needs a saved login (run "shopify theme list --store <store>" once). '
        }\n${detail}`,
      );
    }
  }
}

export const ACCESS_DENIED = /access denied|access_denied|exemption|write_themes|not permitted|not approved/i;

/** Tries the Admin API first; if Shopify refuses theme writes, switches to the CLI for the rest of the run. */
export class FallbackThemeWriter implements ThemeWriter {
  private useFallback = false;
  constructor(
    private readonly primary: ThemeWriter,
    private readonly fallback: ThemeWriter,
    private readonly log: (message: string) => void = console.log,
  ) {}

  get name(): string {
    return this.useFallback ? this.fallback.name : this.primary.name;
  }

  async upsert(theme: Theme, files: ThemeFile[]): Promise<void> {
    if (!this.useFallback) {
      try {
        await this.primary.upsert(theme, files);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!ACCESS_DENIED.test(msg)) throw e;
        this.log(`  Shopify refused theme writes through the Admin API (${msg.slice(0, 100)}). Switching to the Shopify CLI.`);
        this.useFallback = true;
      }
    }
    await this.fallback.upsert(theme, files);
  }
}

export type ThemeWriterMode = 'auto' | 'admin-api' | 'cli';

export function buildThemeWriter(
  mode: ThemeWriterMode,
  opts: { shopify: Shopify; store: string; password?: string; workDir: string; run?: Runner; log?: (m: string) => void },
): ThemeWriter {
  const admin = new AdminApiThemeWriter(opts.shopify);
  const cli = new CliThemeWriter(opts.store, opts.password, opts.workDir, opts.run);
  if (mode === 'admin-api') return admin;
  if (mode === 'cli') return cli;
  return new FallbackThemeWriter(admin, cli, opts.log);
}
