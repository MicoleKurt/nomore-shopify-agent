import { Liquid } from 'liquidjs';

export interface SchemaSetting {
  type: string;
  id?: string;
  label?: string;
  default?: unknown;
}
export interface SchemaBlock {
  type: string;
  name: string;
  settings?: SchemaSetting[];
}
export interface Preset {
  name: string;
  settings?: Record<string, unknown>;
  blocks?: Array<{ type: string; settings?: Record<string, unknown> }>;
}
export interface SectionSchema {
  name: string;
  settings?: SchemaSetting[];
  blocks?: SchemaBlock[];
  presets?: Preset[];
  [key: string]: unknown;
}

export interface LintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  schema?: SectionSchema;
}

const SCHEMA_RE = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;
const DISPLAY_ONLY = new Set(['header', 'paragraph']);

export function splitSchema(source: string): { body: string; schemaText: string | null } {
  const m = SCHEMA_RE.exec(source);
  return { body: source.replace(SCHEMA_RE, ''), schemaText: m ? m[1]!.trim() : null };
}

/** Everything a visitor could read, after Liquid and tags are removed. */
export function visibleLiteralText(body: string): string {
  return body
    .replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, '')
    .replace(/{%-?\s*(style|stylesheet|javascript)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/{%[\s\S]*?%}/g, '')
    .replace(/{{[\s\S]*?}}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

const TEXT_ATTRS = ['alt', 'aria-label', 'title', 'placeholder', 'value'];

function checkBalance(body: string, errors: string[]): void {
  const pairs: Array<[string, string]> = [
    ['if', 'endif'],
    ['unless', 'endunless'],
    ['for', 'endfor'],
    ['case', 'endcase'],
    ['capture', 'endcapture'],
  ];
  for (const [open, close] of pairs) {
    const o = (body.match(new RegExp(`{%-?\\s*${open}\\b`, 'g')) ?? []).length;
    const c = (body.match(new RegExp(`{%-?\\s*${close}\\b`, 'g')) ?? []).length;
    if (o !== c) errors.push(`Unbalanced Liquid: ${o} x {% ${open} %} but ${c} x {% ${close} %}`);
  }
}

/** liquidjs rejects tags it does not know at parse time; register the Shopify-only ones as syntax stubs. */
export function shopifyLiquid(): Liquid {
  const engine = new Liquid();
  for (const name of ['form', 'paginate']) {
    engine.registerTag(name, {
      parse(this: any, token: any, remainTokens: any) {
        this.tpls = [];
        const stream = this.liquid.parser
          .parseStream(remainTokens)
          .on('template', (tpl: unknown) => this.tpls.push(tpl))
          .on(`tag:end${name}`, () => stream.stop())
          .on('end', () => {
            throw new Error(`tag ${token.getText()} not closed`);
          });
        stream.start();
      },
      render: function* () {
        /* syntax check only */
      },
    });
  }
  for (const name of ['section', 'sections', 'content_for']) {
    engine.registerTag(name, { parse() {}, render: function* () {} });
  }
  return engine;
}

export function lintSection(source: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { body, schemaText } = splitSchema(source);

  // 1. Schema
  let schema: SectionSchema | undefined;
  if (!schemaText) {
    errors.push('Missing {% schema %} block. All content must be editable through the schema.');
  } else {
    try {
      schema = JSON.parse(schemaText) as SectionSchema;
    } catch (e) {
      errors.push(`Schema is not valid JSON: ${(e as Error).message}`);
    }
  }
  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  if (schema) {
    if (!schema.name) errors.push('Schema needs a "name".');
    for (const s of schema.settings ?? []) {
      if (s.id) sectionIds.add(s.id);
      else if (!DISPLAY_ONLY.has(s.type)) errors.push(`Section setting of type "${s.type}" has no id.`);
    }
    for (const b of schema.blocks ?? []) {
      if (!b.type || !b.name) errors.push('Every block needs a "type" and a "name".');
      for (const s of b.settings ?? []) {
        if (s.id) blockIds.add(s.id);
        else if (!DISPLAY_ONLY.has(s.type)) errors.push(`Block "${b.type}" has a setting of type "${s.type}" with no id.`);
      }
    }
    if (!schema.presets?.length) {
      errors.push('Schema needs presets[0] with the default blocks and settings (they seed the template).');
    } else {
      const blockTypes = new Set((schema.blocks ?? []).map((b) => b.type));
      for (const pb of schema.presets[0]!.blocks ?? []) {
        if (!blockTypes.has(pb.type)) errors.push(`Preset uses unknown block type "${pb.type}".`);
      }
    }
  }

  // 2. Root marker used by the screenshot tool
  if (!/data-nomore-root/.test(body)) errors.push('The outermost element must carry the attribute data-nomore-root.');

  // 3. No hardcoded visible text
  const leftover = visibleLiteralText(body).replace(/\s+/g, ' ').trim();
  if (/[A-Za-z0-9]/.test(leftover)) {
    errors.push(`Hardcoded text found outside Liquid output: "${leftover.slice(0, 120)}". Every visible string must come from a setting.`);
  }
  for (const attr of TEXT_ATTRS) {
    const re = new RegExp(`\\s${attr}\\s*=\\s*"([^"]*)"`, 'gi');
    for (const m of body.matchAll(re)) {
      const v = m[1]!;
      if (/{{|{%/.test(v)) continue;
      if (/[A-Za-z]/.test(v) && !(attr === 'value' && /^(on|off|1|0)$/i.test(v))) {
        errors.push(`Hardcoded ${attr}="${v.slice(0, 60)}". Use a setting.`);
      }
    }
  }

  // 4. No hardcoded image URLs (fonts excepted)
  const urlHits = [
    ...body.matchAll(/(?:src|srcset|href|poster)\s*=\s*"((?:https?:)?\/\/[^"]+)"/gi),
    ...body.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^)'"]+)/gi),
  ]
    .map((m) => m[1]!)
    .filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
  for (const u of urlHits) errors.push(`Hardcoded URL ${u.slice(0, 80)}. Images and links must come from settings.`);

  // 5. Settings referenced must exist
  const referencedSection = new Set([...body.matchAll(/section\.settings\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!));
  const referencedBlock = new Set([...body.matchAll(/block\.settings\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!));
  if (schema) {
    for (const id of referencedSection) if (!sectionIds.has(id)) errors.push(`section.settings.${id} is used but not defined in the schema.`);
    for (const id of referencedBlock) if (!blockIds.has(id)) errors.push(`block.settings.${id} is used but not defined in any block.`);
    for (const id of sectionIds) if (!referencedSection.has(id)) warnings.push(`Section setting "${id}" is defined but never used.`);
    for (const id of blockIds) if (!referencedBlock.has(id)) warnings.push(`Block setting "${id}" is defined but never used.`);
  }

  // 6. Liquid syntax
  checkBalance(body, errors);
  try {
    const engine = shopifyLiquid();
    const stripped = body
      .replace(/{%-?\s*(style|stylesheet|javascript)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '');
    engine.parse(stripped);
  } catch (e) {
    errors.push(`Liquid syntax error: ${(e as Error).message.split('\n')[0]}`);
  }

  return { ok: errors.length === 0, errors, warnings, schema };
}
