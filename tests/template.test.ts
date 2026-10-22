import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lintSection } from '../src/lint.js';
import { buildProductTemplate, stringifyTemplate } from '../src/template.js';

const good = readFileSync(new URL('./fixtures/good.liquid', import.meta.url), 'utf8');
const schema = lintSection(good).schema!;

describe('buildProductTemplate', () => {
  it('seeds the template from presets[0] so the editor opens with default content', () => {
    const t = buildProductTemplate(schema, 'nomore-landing');
    expect(t.order).toEqual(['main']);
    expect(t.sections.main!.type).toBe('nomore-landing');
    expect(t.sections.main!.settings).toEqual({ heading: 'Are you struggling with colds?' });
  });

  it('gives repeated block types unique ids and keeps their order', () => {
    const t = buildProductTemplate(schema, 'nomore-landing');
    expect(t.sections.main!.block_order).toEqual(['review_1', 'review_2', 'stat_1']);
    expect(Object.keys(t.sections.main!.blocks)).toEqual(['review_1', 'review_2', 'stat_1']);
    expect(t.sections.main!.blocks.review_2).toEqual({ type: 'review', settings: { quote: 'Sleeping better.', author: 'Joe' } });
  });

  it('every block id in block_order exists in blocks', () => {
    const main = buildProductTemplate(schema, 'nomore-landing').sections.main!;
    for (const id of main.block_order) expect(main.blocks[id]).toBeDefined();
  });

  it('throws when there is no preset', () => {
    expect(() => buildProductTemplate({ name: 'x' }, 'x')).toThrow(/presets\[0\]/);
  });

  it('serializes to JSON Shopify accepts', () => {
    const parsed = JSON.parse(stringifyTemplate(buildProductTemplate(schema, 'nomore-landing')));
    expect(parsed.sections.main.type).toBe('nomore-landing');
  });
});
