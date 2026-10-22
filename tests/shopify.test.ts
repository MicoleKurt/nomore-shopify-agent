import { describe, expect, it, vi } from 'vitest';
import { connectShopify, requestClientCredentialsToken, Shopify, themeGid, themeNumericId } from '../src/shopify.js';

type Handler = (query: string, variables: Record<string, any>) => { status?: number; body?: unknown };

/** A fake fetch that answers by the GraphQL operation found in the request. */
function fakeFetch(handler: Handler) {
  const calls: Array<{ query: string; variables: Record<string, any>; token: string | null }> = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body));
    const headers = init!.headers as Record<string, string>;
    calls.push({ query, variables, token: headers['x-shopify-access-token'] ?? null });
    const { status = 200, body = { data: {} } } = handler(query, variables);
    return new Response(JSON.stringify(body), { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('Shopify client', () => {
  it('sends the token header and returns data', async () => {
    const f = fakeFetch(() => ({ body: { data: { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn', role: 'MAIN' }] } } } }));
    const s = new Shopify('s.myshopify.com', 'tok', f.impl);
    expect(await s.listThemes()).toHaveLength(1);
    expect(f.calls[0]!.token).toBe('tok');
  });

  it('retries once on HTTP 429 and then succeeds', async () => {
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? { status: 429 } : { body: { data: { themes: { nodes: [] } } } }));
    const s = new Shopify('s.myshopify.com', 'tok', f.impl);
    expect(await s.listThemes()).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it('explains a rejected token instead of dumping the response', async () => {
    const f = fakeFetch(() => ({ status: 401 }));
    await expect(new Shopify('s.myshopify.com', 'bad', f.impl).listThemes()).rejects.toThrow(/SHOPIFY_ADMIN_TOKEN/);
  });

  it('surfaces GraphQL errors', async () => {
    const f = fakeFetch(() => ({ body: { errors: [{ message: 'Access denied for themes field.' }] } }));
    await expect(new Shopify('s.myshopify.com', 't', f.impl).listThemes()).rejects.toThrow(/Access denied/);
  });

  it('reports theme file userErrors with the file name', async () => {
    const f = fakeFetch(() => ({
      body: { data: { themeFilesUpsert: { upsertedThemeFiles: [], userErrors: [{ message: 'Liquid syntax error', filename: 'sections/x.liquid', code: 'INVALID' }] } } },
    }));
    const s = new Shopify('s.myshopify.com', 't', f.impl);
    await expect(s.upsertThemeFiles('gid://shopify/OnlineStoreTheme/1', [{ filename: 'sections/x.liquid', content: 'x' }])).rejects.toThrow(
      /sections\/x\.liquid: Liquid syntax error/,
    );
  });

  describe('upsertPlaceholderProduct', () => {
    const input = { handle: 'nomore-placeholder', title: 'Device', price: '29.95', imageUrl: 'https://cdn/x.png', templateSuffix: 'nomore' };
    const product = { id: 'gid://shopify/Product/9', handle: 'nomore-placeholder', title: 'Device', templateSuffix: 'nomore', media: { nodes: [{ id: 'm1' }] } };

    function store(existing: boolean) {
      return fakeFetch((q) => {
        if (q.includes('productByHandle')) return { body: { data: { productByHandle: existing ? product : null } } };
        if (q.includes('productSet')) return { body: { data: { productSet: { product: { id: product.id }, userErrors: [] } } } };
        if (q.includes('publications')) return { body: { data: { publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Online Store' }] } } } };
        if (q.includes('publishablePublish')) return { body: { data: { publishablePublish: { userErrors: [] } } } };
        return { body: { data: {} } };
      });
    }

    it('creates with the image on first run', async () => {
      const f = store(false);
      // first lookup misses, the lookup after the upsert finds it
      let lookups = 0;
      const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const q = JSON.parse(String(init!.body)).query as string;
        if (q.includes('productByHandle')) {
          lookups++;
          return new Response(JSON.stringify({ data: { productByHandle: lookups === 1 ? null : product } }));
        }
        return f.impl(url, init);
      }) as unknown as typeof fetch;
      const s = new Shopify('s.myshopify.com', 't', impl);
      const p = await s.upsertPlaceholderProduct(input);
      expect(p.handle).toBe('nomore-placeholder');
      const set = f.calls.find((c) => c.query.includes('productSet'))!;
      expect(set.variables.identifier).toBeUndefined();
      expect(set.variables.input.files).toHaveLength(1);
    });

    it('updates in place on a re-run: same identifier, no second image, no duplicate product', async () => {
      const f = store(true);
      const s = new Shopify('s.myshopify.com', 't', f.impl);
      await s.upsertPlaceholderProduct(input);
      const set = f.calls.find((c) => c.query.includes('productSet'))!;
      expect(set.variables.identifier).toEqual({ id: product.id });
      expect(set.variables.input.files).toBeUndefined();
    });
  });

  describe('client-credentials token (Dev Dashboard apps)', () => {
    it('posts the form body Shopify documents and returns the token', async () => {
      const impl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_from_exchange', scope: 'write_themes', expires_in: 86399 })));
      const token = await requestClientCredentialsToken('s.myshopify.com', 'cid', 'secret', impl as unknown as typeof fetch);
      expect(token).toBe('shpat_from_exchange');
      const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://s.myshopify.com/admin/oauth/access_token');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
      expect(new URLSearchParams(String(init.body)).get('grant_type')).toBe('client_credentials');
      expect(new URLSearchParams(String(init.body)).get('client_id')).toBe('cid');
    });

    it('explains shop_not_permitted in plain words', async () => {
      const impl = vi.fn(async () => new Response(JSON.stringify({ error: 'shop_not_permitted' }), { status: 400 }));
      await expect(requestClientCredentialsToken('s.myshopify.com', 'cid', 'secret', impl as unknown as typeof fetch)).rejects.toThrow(/same Shopify organization/);
    });

    it('never echoes the client secret in an error', async () => {
      const impl = vi.fn(async () => new Response('<html>nope</html>', { status: 502 }));
      await expect(requestClientCredentialsToken('s.myshopify.com', 'cid', 'TOPSECRET', impl as unknown as typeof fetch)).rejects.not.toThrow(/TOPSECRET/);
    });

    it('connectShopify prefers a static token and skips the exchange', async () => {
      const impl = vi.fn();
      const s = await connectShopify({ SHOPIFY_STORE: 's.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'shpat_static_1' }, impl as unknown as typeof fetch);
      expect(s).toBeInstanceOf(Shopify);
      expect(impl).not.toHaveBeenCalled();
    });

    it('connectShopify exchanges the credentials when there is no static token', async () => {
      const impl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok-from-exchange' })));
      await connectShopify({ SHOPIFY_STORE: 's.myshopify.com', SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'sec' }, impl as unknown as typeof fetch);
      expect(impl).toHaveBeenCalledTimes(1);
    });
  });

  it('converts theme ids both ways', () => {
    expect(themeNumericId('gid://shopify/OnlineStoreTheme/12345')).toBe('12345');
    expect(themeGid('12345')).toBe('gid://shopify/OnlineStoreTheme/12345');
    expect(() => themeNumericId('nope')).toThrow();
  });
});
