const API_VERSION = '2025-07';

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export interface Theme {
  id: string;
  name: string;
  role: string;
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
  filename?: string | null;
}

export interface ProductSummary {
  id: string;
  handle: string;
  title: string;
  templateSuffix: string | null;
  mediaCount: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Dev Dashboard apps (the only kind that can be created since 1 Jan 2026) have no static token.
 * The client-credentials grant swaps the app's client id and secret for a token valid for 24 hours.
 */
export async function requestClientCredentialsToken(
  store: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const raw = await res.text();
  let body: { access_token?: string; error?: string; error_description?: string } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* not JSON; reported below */
  }
  if (!res.ok || !body.access_token) {
    const why = body.error === 'shop_not_permitted'
      ? 'the app and the store are not in the same Shopify organization (create the store from the same Partners/Dev Dashboard account)'
      : body.error_description || body.error || `HTTP ${res.status}`;
    throw new ShopifyError(`Could not get an Admin API token from ${store}: ${why}. Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET and that the app is installed on the store.`);
  }
  return body.access_token;
}

/** Builds a client from either a static token or Dev Dashboard credentials. */
export async function connectShopify(
  cfg: { SHOPIFY_STORE: string; SHOPIFY_ADMIN_TOKEN?: string; SHOPIFY_CLIENT_ID?: string; SHOPIFY_CLIENT_SECRET?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Shopify> {
  if (cfg.SHOPIFY_ADMIN_TOKEN) return new Shopify(cfg.SHOPIFY_STORE, cfg.SHOPIFY_ADMIN_TOKEN, fetchImpl);
  if (!cfg.SHOPIFY_CLIENT_ID || !cfg.SHOPIFY_CLIENT_SECRET) {
    throw new ShopifyError('No Shopify credentials: set SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.');
  }
  const token = await requestClientCredentialsToken(cfg.SHOPIFY_STORE, cfg.SHOPIFY_CLIENT_ID, cfg.SHOPIFY_CLIENT_SECRET, fetchImpl);
  return new Shopify(cfg.SHOPIFY_STORE, token, fetchImpl);
}

export class Shopify {
  constructor(
    readonly store: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One GraphQL call with retry on throttling and 5xx. Throws with every error message. */
  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetchImpl(`https://${this.store}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': this.token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new ShopifyError(`Shopify returned HTTP ${res.status}`);
        await sleep(600 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(`Shopify rejected the token (HTTP ${res.status}). Check SHOPIFY_ADMIN_TOKEN and the app's scopes.`);
      }
      if (!res.ok) throw new ShopifyError(`Shopify returned HTTP ${res.status}`, await res.text());
      const body = (await res.json()) as GraphQLResponse<T>;
      if (body.errors?.length) {
        if (body.errors.some((e) => e.extensions?.code === 'THROTTLED')) {
          lastError = new ShopifyError('Throttled');
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw new ShopifyError(body.errors.map((e) => e.message).join('; '), body.errors);
      }
      if (!body.data) throw new ShopifyError('Shopify returned no data');
      return body.data;
    }
    throw lastError instanceof Error ? lastError : new ShopifyError('Shopify request failed');
  }

  async listThemes(): Promise<Theme[]> {
    const data = await this.gql<{ themes: { nodes: Theme[] } }>(`{ themes(first: 20) { nodes { id name role } } }`);
    return data.themes.nodes;
  }

  async readThemeFiles(themeId: string, filenames: string[]): Promise<Record<string, string | null>> {
    const data = await this.gql<{
      theme: { files: { nodes: Array<{ filename: string; body: { content?: string } }> } } | null;
    }>(
      `query($id: ID!, $names: [String!]!) {
        theme(id: $id) { files(filenames: $names, first: 20) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } }
      }`,
      { id: themeId, names: filenames },
    );
    const found: Record<string, string | null> = Object.fromEntries(filenames.map((f) => [f, null]));
    for (const n of data.theme?.files.nodes ?? []) found[n.filename] = n.body.content ?? null;
    return found;
  }

  async upsertThemeFiles(themeId: string, files: Array<{ filename: string; content: string }>): Promise<string[]> {
    const data = await this.gql<{
      themeFilesUpsert: { upsertedThemeFiles: Array<{ filename: string }>; userErrors: UserError[] };
    }>(
      `mutation($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          upsertedThemeFiles { filename }
          userErrors { field message code filename }
        }
      }`,
      { themeId, files: files.map((f) => ({ filename: f.filename, body: { type: 'TEXT', value: f.content } })) },
    );
    const { userErrors, upsertedThemeFiles } = data.themeFilesUpsert;
    if (userErrors.length) throw new ShopifyError(formatUserErrors(userErrors), userErrors);
    return upsertedThemeFiles.map((f) => f.filename);
  }

  async findProduct(handle: string): Promise<ProductSummary | null> {
    const data = await this.gql<{
      productByHandle: { id: string; handle: string; title: string; templateSuffix: string | null; media: { nodes: unknown[] } } | null;
    }>(
      `query($handle: String!) { productByHandle(handle: $handle) { id handle title templateSuffix media(first: 30) { nodes { id } } } }`,
      { handle },
    );
    const p = data.productByHandle;
    return p ? { id: p.id, handle: p.handle, title: p.title, templateSuffix: p.templateSuffix, mediaCount: p.media.nodes.length } : null;
  }

  /** Idempotent upsert: the same handle always ends up as one product, so a retry never duplicates it. */
  async upsertPlaceholderProduct(input: {
    handle: string;
    title: string;
    price: string;
    imageUrl: string;
    templateSuffix: string;
  }): Promise<ProductSummary> {
    const existing = await this.findProduct(input.handle);
    const productInput = {
      title: input.title,
      handle: input.handle,
      status: 'ACTIVE',
      templateSuffix: input.templateSuffix,
      descriptionHtml: '<p>Placeholder product used to render the landing page sections.</p>',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], price: input.price }],
      ...(existing ? {} : { files: [{ originalSource: input.imageUrl, contentType: 'IMAGE', alt: input.title }] }),
    };
    const data = await this.gql<{
      productSet: { product: { id: string } | null; userErrors: UserError[] };
    }>(
      `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(input: $input, identifier: $identifier, synchronous: true) {
          product { id }
          userErrors { field message code }
        }
      }`,
      { input: productInput, identifier: existing ? { id: existing.id } : undefined },
    );
    const { product, userErrors } = data.productSet;
    if (userErrors.length || !product) throw new ShopifyError(formatUserErrors(userErrors) || 'productSet returned no product', userErrors);
    await this.publishToOnlineStore(product.id);
    const done = await this.findProduct(input.handle);
    if (!done) throw new ShopifyError('Product was not found after productSet');
    return done;
  }

  async publishToOnlineStore(productId: string): Promise<void> {
    const pubs = await this.gql<{ publications: { nodes: Array<{ id: string; name: string }> } }>(
      `{ publications(first: 20) { nodes { id name } } }`,
    );
    const online = pubs.publications.nodes.find((p) => /online store/i.test(p.name));
    if (!online) return;
    const data = await this.gql<{ publishablePublish: { userErrors: UserError[] } }>(
      `mutation($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id: productId, input: [{ publicationId: online.id }] },
    );
    const errs = data.publishablePublish.userErrors.filter((e) => !/already/i.test(e.message));
    if (errs.length) throw new ShopifyError(formatUserErrors(errs), errs);
  }
}

export function formatUserErrors(errors: UserError[]): string {
  return errors.map((e) => `${e.filename ? e.filename + ': ' : ''}${e.message}${e.code ? ` (${e.code})` : ''}`).join('; ');
}

export function themeNumericId(gid: string): string {
  const m = /(\d+)$/.exec(gid);
  if (!m) throw new ShopifyError(`Unexpected theme id: ${gid}`);
  return m[1]!;
}

export function themeGid(numeric: string): string {
  return `gid://shopify/OnlineStoreTheme/${numeric}`;
}
