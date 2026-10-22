import type { SectionSchema } from './lint.js';

export interface ProductTemplate {
  sections: Record<
    string,
    {
      type: string;
      settings: Record<string, unknown>;
      blocks: Record<string, { type: string; settings: Record<string, unknown> }>;
      block_order: string[];
    }
  >;
  order: string[];
}

/**
 * JSON templates do not copy a preset's blocks automatically, so the template is generated
 * from presets[0]. The theme editor then opens with every default text and image in place,
 * all of it editable, none of it hardcoded in Liquid.
 */
export function buildProductTemplate(schema: SectionSchema, sectionType: string): ProductTemplate {
  const preset = schema.presets?.[0];
  if (!preset) throw new Error('Schema has no presets[0]; cannot build the template.');
  const blocks: ProductTemplate['sections'][string]['blocks'] = {};
  const blockOrder: string[] = [];
  const counters = new Map<string, number>();
  for (const b of preset.blocks ?? []) {
    const n = (counters.get(b.type) ?? 0) + 1;
    counters.set(b.type, n);
    const id = `${b.type}_${n}`;
    blocks[id] = { type: b.type, settings: b.settings ?? {} };
    blockOrder.push(id);
  }
  return {
    sections: { main: { type: sectionType, settings: preset.settings ?? {}, blocks, block_order: blockOrder } },
    order: ['main'],
  };
}

export function stringifyTemplate(t: ProductTemplate): string {
  return JSON.stringify(t, null, 2);
}
