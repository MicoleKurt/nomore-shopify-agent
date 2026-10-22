import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { absoluteUrl } from '../src/source.js';

const valid = {
  ANTHROPIC_API_KEY: 'sk-ant-test-key-123',
  SHOPIFY_STORE: 'my-test-store.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_test_token_123',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.MODEL).toBe('claude-sonnet-5-5');
    expect(c.MAX_BUDGET_USD).toBe(4);
    expect(c.SOURCE_URL).toContain('try-nomore.com');
  });

  it('coerces the budget from a string', () => {
    expect(loadConfig({ ...valid, MAX_BUDGET_USD: '2.5' }).MAX_BUDGET_USD).toBe(2.5);
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({})).toThrow(/SHOPIFY_STORE[\s\S]*SHOPIFY_ADMIN_TOKEN/);
  });

  it('does not need an Anthropic key (falls back to the Claude Code login)', () => {
    const { ANTHROPIC_API_KEY: _drop, ...rest } = valid;
    expect(loadConfig(rest).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('rejects a store domain that is not myshopify.com', () => {
    expect(() => loadConfig({ ...valid, SHOPIFY_STORE: 'https://my-test-store.myshopify.com/' })).toThrow(/my-store\.myshopify\.com/);
  });

  it('treats a blank theme id as "use the live theme"', () => {
    expect(loadConfig({ ...valid, SHOPIFY_THEME_ID: '' }).SHOPIFY_THEME_ID).toBeUndefined();
  });

  it('rejects a non-numeric theme id', () => {
    expect(() => loadConfig({ ...valid, SHOPIFY_THEME_ID: 'dawn' })).toThrow(/SHOPIFY_THEME_ID/);
  });

  it('accepts Dev Dashboard credentials instead of a static token', () => {
    const { SHOPIFY_ADMIN_TOKEN: _drop, ...rest } = valid;
    const c = loadConfig({ ...rest, SHOPIFY_CLIENT_ID: 'client-id-123', SHOPIFY_CLIENT_SECRET: 'shpss_secret_123' });
    expect(c.SHOPIFY_ADMIN_TOKEN).toBeUndefined();
    expect(c.SHOPIFY_CLIENT_ID).toBe('client-id-123');
  });

  it('needs the client secret as well as the client id', () => {
    const { SHOPIFY_ADMIN_TOKEN: _drop, ...rest } = valid;
    expect(() => loadConfig({ ...rest, SHOPIFY_CLIENT_ID: 'client-id-123' })).toThrow(/SHOPIFY_CLIENT_SECRET/);
  });

  it('ignores blank credential lines left in .env', () => {
    expect(loadConfig({ ...valid, SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '' }).SHOPIFY_ADMIN_TOKEN).toBe(valid.SHOPIFY_ADMIN_TOKEN);
  });
});

describe('absoluteUrl', () => {
  it('adds https to protocol-relative CDN URLs', () => {
    expect(absoluteUrl('//cdn.shopify.com/a.png')).toBe('https://cdn.shopify.com/a.png');
  });
  it('resolves root-relative paths', () => {
    expect(absoluteUrl('/cdn/a.png')).toBe('https://try-nomore.com/cdn/a.png');
  });
  it('leaves absolute URLs alone', () => {
    expect(absoluteUrl('https://x.com/a.png')).toBe('https://x.com/a.png');
  });
});
