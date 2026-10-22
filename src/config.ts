import { z } from 'zod';

const Env = z.object({
  // Optional: without a key the SDK uses the Claude Code login on this machine.
  ANTHROPIC_API_KEY: z.string().min(10, 'looks too short').optional(),
  SHOPIFY_STORE: z
    .string({ error: 'is missing, it should look like my-store.myshopify.com' })
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'must look like my-store.myshopify.com (no https://, no slash)'),
  // Either a static Admin API token (apps created before 2026) ...
  SHOPIFY_ADMIN_TOKEN: z.string().min(10).optional(),
  // ... or Dev Dashboard credentials, exchanged for a 24-hour token at start-up.
  SHOPIFY_CLIENT_ID: z.string().min(5).optional(),
  SHOPIFY_CLIENT_SECRET: z.string().min(5).optional(),
  SHOPIFY_STORE_PASSWORD: z.string().optional(),
  // How theme files are uploaded. "auto" tries the Admin API and falls back to `shopify theme push`.
  THEME_WRITER: z.enum(['auto', 'admin-api', 'cli']).default('auto'),
  // Theme Access app password for the CLI route (optional if the CLI is already logged in).
  SHOPIFY_THEME_PASSWORD: z.string().min(8).optional(),
  SHOPIFY_THEME_ID: z.string().regex(/^\d+$/, 'SHOPIFY_THEME_ID must be the numeric theme id').optional(),
  SOURCE_URL: z
    .string()
    .url()
    .default('https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis'),
  MODEL: z.string().default('claude-sonnet-5-5'),
  MAX_BUDGET_USD: z.coerce.number().positive().default(4),
});

export type Config = z.infer<typeof Env>;

/** Reads and validates the environment. Fails with every problem listed, once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A blank line in .env ("SHOPIFY_THEME_ID=") means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = Env.safeParse(present);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  const has = (k: string) => typeof present[k] === 'string';
  if (!has('SHOPIFY_ADMIN_TOKEN') && !(has('SHOPIFY_CLIENT_ID') && has('SHOPIFY_CLIENT_SECRET'))) {
    problems.push('SHOPIFY_ADMIN_TOKEN: set it, or set both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app)');
  }
  if (problems.length || !parsed.success) {
    throw new Error(`Configuration problem:\n${problems.map((p) => `  - ${p}`).join('\n')}\nCopy .env.example to .env and fill it in.`);
  }
  return parsed.data;
}

export const SECTION_FILE = 'sections/nomore-landing.liquid';
export const TEMPLATE_FILE = 'templates/product.nomore.json';
export const TEMPLATE_SUFFIX = 'nomore';
export const PLACEHOLDER_HANDLE = 'nomore-placeholder';
export const VIEWPORT = { width: 390, height: 844 } as const;
