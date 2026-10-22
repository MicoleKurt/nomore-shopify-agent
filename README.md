# nomore-shopify-agent

A script built on the **Claude Agent SDK** that takes a product-page URL and rebuilds its first three
sections as **one Liquid section** in a Shopify test store, matching the original as closely as it can on a
phone-size screen. Every text and every image is editable in the theme editor; nothing is hardcoded.

```
npm run run
```

## What it builds

For `https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis` the first three
sections at 390 px are:

1. the product hero (gallery, title, rating, benefits, bundle cards with their prices, add to cart),
2. the "Are you struggling with…" image-with-text section,
3. the "100%" counter band.

The result is `sections/nomore-landing.liquid`, rendered by an alternate product template
(`templates/product.nomore.json`) assigned to a simple placeholder product (one variant, one image). The
purchase logic is deliberately plain, since every bundle card adds the placeholder variant, but the look of
the hero is rebuilt, and the bundle cards, prices and labels are editable blocks and text settings.

## How it works

```
                 +---------------------------+
 URL ----------> |  Claude (Agent SDK query) |  only the 7 tools below exist:
                 +-------------+-------------+  no shell, no files, no web
                               |
   inspect_source -------------+--> Playwright @390px: texts + computed styles, images, HTML, screenshots
   get_theme_state ------------+--> Admin API: pick the theme, see what already exists
   create_placeholder_product -+--> Admin API productSet (idempotent) + publish to Online Store
   write_section --------------+--> LINT, then upload section + generated JSON template
   screenshot_preview ---------+--> Playwright on the store preview (password handled)
   compare_preview ------------+--> pixelmatch vs. the original, per-300px bands + side-by-side strips
   verify_final ---------------+--> final checks, out/report.json
```

The model sees the original and its own result as images and as numbers, edits, and repeats.

**Design decisions**

- **A linter is the "no hardcoded content" guarantee.** `write_section` rejects the upload, with exact
  reasons, if a visible string, alt text, label, image URL or `url()` is not coming from a setting, if a
  referenced setting is not in the schema, if the schema has no `presets[0]`, or if the Liquid is
  unbalanced. The model cannot upload a section that breaks the brief.
- **Defaults live in `presets[0]`, and the template is generated from it.** JSON templates do not copy a
  preset's blocks on their own, so the script builds `product.nomore.json` from the preset. The theme
  editor then opens with all default copy and images in place, all editable.
- **Images** are `image_picker` settings with a text setting holding the original CDN URL as fallback, so the
  page renders before anything is uploaded and each image can still be replaced in the editor.
- **Bounded loop.** Max 40 turns, a hard `maxBudgetUsd`, and a `PreToolUse` hook that denies `write_section`
  after 6 uploads. It stops as soon as the pixel difference is at or below 8 %.
- **Safe to re-run.** The placeholder product is an upsert on a fixed handle, never a duplicate. Theme pushes
  only touch the two files and never delete anything.
- **Stale-screenshot guard.** A comparison is refused if the screenshot belongs to an older upload.
- **Cost is reported** from the SDK's `total_cost_usd` at the end of every run, and written to
  `out/run-summary.json`.

## Setup

You need a Shopify dev store, an Anthropic API key, and Node 20.12 or newer.

```
npm install
npx playwright install chromium
copy .env.example .env      # then fill it in
```

### Shopify

1. **Dev store.** Create one in your Shopify Partners / Dev Dashboard account. Set a storefront password
   (Online Store > Preferences) and put it in `SHOPIFY_STORE_PASSWORD`.
2. **Admin API access.** Since 1 January 2026 new apps are created in the **Dev Dashboard**
   (dev.shopify.com/dashboard): create an app, give a version these scopes, release it, and install it on
   the dev store:

   `read_themes, write_themes, read_products, write_products, read_publications, write_publications`

   Copy the app's **Client ID** and **Client secret** (Settings) into `SHOPIFY_CLIENT_ID` and
   `SHOPIFY_CLIENT_SECRET`. The script exchanges them for a 24-hour token on start-up. An older `shpat_`
   token in `SHOPIFY_ADMIN_TOKEN` also works.
3. **Theme uploads.** Shopify only lets apps with an exemption write theme files through the Admin API, and
   it answers `ACCESS_DENIED` otherwise. With `THEME_WRITER=auto` (default) the script tries the Admin API
   and, if refused, switches to `shopify theme push`. For that route install the free **Theme Access** app in
   the store, create a password and put it in `SHOPIFY_THEME_PASSWORD` (or run
   `shopify theme list --store <store>` once to log the CLI in). The CLI is used from your PATH, or fetched
   with `npx`.

### Anthropic

Put your key in `ANTHROPIC_API_KEY`. `MAX_BUDGET_USD` (default 4) is a hard stop for the whole run.

## Run

```
npm run run               # full run, then opens the page in a phone-size window for the screen recording
npm run run -- --no-phone # same, without the final phone window
npm run extract           # only capture the original (no Shopify, no API key needed)
npm test                  # 70 tests
npm run typecheck
```

Output goes to `out/`: `nomore-landing.liquid` (the final section), `section-v1..n.liquid` (each version),
`source/` (original screenshots + `source-brief.json`), `preview/` (screenshots and comparison strips),
`report.json` (final checks), `run-summary.json` (uploads, diff history, API cost, preview URL).

## Tests

`npm test` covers the linter (every rule, positive and negative), the template generator, the image
comparison, config validation, the Shopify client (retries, throttling, auth errors, idempotent product
upsert, client-credentials exchange), the theme-upload routes and the fallback between them, and the agent
tools (rejected uploads reach Shopify never, stale screenshots are refused, the report fails honestly).
The model call itself and the live Shopify store are not covered by tests: they need your keys.

## Known limits

- The pixel comparison is a guide, not a proof: fonts, lazy images and animations can move a few percent.
- The "first 3 sections" are chosen by position on the rendered page at 390 px, header and announcement bar
  excluded. If the source site changes its layout the pick changes with it.
- Behaviour is simplified, appearance is not: the original's bundle selection, cart logic and any app
  integrations are not reproduced. Cards look like the original and add the placeholder product.
