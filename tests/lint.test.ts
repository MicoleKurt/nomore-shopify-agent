import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lintSection } from '../src/lint.js';

const good = readFileSync(new URL('./fixtures/good.liquid', import.meta.url), 'utf8');

/** Replace one exact piece of the good fixture so each test breaks exactly one rule. */
function mutate(from: string | RegExp, to: string): string {
  const out = good.replace(from, to);
  expect(out).not.toBe(good);
  return out;
}

describe('lintSection', () => {
  it('accepts a section whose content is all in settings (Shopify form tag included)', () => {
    const r = lintSection(good);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.schema?.presets?.[0]?.blocks).toHaveLength(3);
  });

  it('rejects hardcoded visible text', () => {
    const r = lintSection(mutate('<h1>{{ section.settings.heading }}</h1>', '<h1>Are you struggling?</h1>'));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Hardcoded text/);
  });

  it('rejects hardcoded text mixed with Liquid output', () => {
    const r = lintSection(mutate('<cite>{{ block.settings.author }}</cite>', '<cite>By {{ block.settings.author }}</cite>'));
    expect(r.errors.join('\n')).toMatch(/Hardcoded text/);
  });

  it('rejects a hardcoded alt attribute', () => {
    const r = lintSection(mutate(/alt="\{\{ section\.settings\.image_alt \}\}"/, 'alt="Device"'));
    expect(r.errors.join('\n')).toMatch(/Hardcoded alt/);
  });

  it('rejects a hardcoded button label', () => {
    const r = lintSection(mutate('{{ section.settings.button_label }}', 'Buy now'));
    expect(r.errors.join('\n')).toMatch(/Hardcoded text/);
  });

  it('rejects a hardcoded image URL in src', () => {
    const r = lintSection(mutate('src="{{ section.settings.image_fallback_url }}"', 'src="https://cdn.shopify.com/s/files/a.png"'));
    expect(r.errors.join('\n')).toMatch(/Hardcoded URL/);
  });

  it('rejects a hardcoded image URL in CSS url()', () => {
    const r = lintSection(mutate('padding: 60px 16px;', "padding: 60px 16px; background-image: url('//cdn.shopify.com/a.png');"));
    expect(r.errors.join('\n')).toMatch(/Hardcoded URL/);
  });

  it('allows Google Fonts links', () => {
    expect(lintSection(good).errors.join('\n')).not.toMatch(/Hardcoded URL/);
  });

  it('rejects a setting that is used but not defined', () => {
    const r = lintSection(mutate('{{ section.settings.heading }}', '{{ section.settings.headline }}'));
    expect(r.errors.join('\n')).toMatch(/section\.settings\.headline is used but not defined/);
  });

  it('rejects a block setting that is used but not defined', () => {
    const r = lintSection(mutate('{{ block.settings.quote }}', '{{ block.settings.quotation }}'));
    expect(r.errors.join('\n')).toMatch(/block\.settings\.quotation/);
  });

  it('warns about a defined setting that is never used', () => {
    const r = lintSection(mutate('"settings": [\n    { "type": "color"', '"settings": [\n    { "type": "text", "id": "spare", "label": "Spare" },\n    { "type": "color"'));
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/"spare"/);
  });

  it('requires presets so the template can be generated', () => {
    const noPresets = good.replace(/,\s*"presets": \[[\s\S]*\]\s*\n\}/, '\n}');
    const r = lintSection(noPresets);
    expect(r.errors.join('\n')).toMatch(/presets\[0\]/);
  });

  it('rejects a preset that uses an undefined block type', () => {
    const r = lintSection(mutate('{ "type": "stat", "settings": { "value"', '{ "type": "ghost", "settings": { "value"'));
    expect(r.errors.join('\n')).toMatch(/unknown block type "ghost"/);
  });

  it('requires the data-nomore-root marker', () => {
    const r = lintSection(good.replace('<div data-nomore-root>', '<div>').replace(/\[data-nomore-root\]/g, '.x'));
    expect(r.errors.join('\n')).toMatch(/data-nomore-root/);
  });

  it('rejects unbalanced Liquid', () => {
    const r = lintSection(mutate('{%- endfor -%}', ''));
    expect(r.errors.join('\n')).toMatch(/Unbalanced Liquid/);
  });

  it('rejects a missing schema', () => {
    const r = lintSection(good.replace(/{% schema %}[\s\S]*{% endschema %}/, ''));
    expect(r.errors.join('\n')).toMatch(/Missing \{% schema %\}/);
  });

  it('rejects invalid schema JSON', () => {
    const r = lintSection(mutate('"name": "NoMore landing",\n  "settings"', '"name": "NoMore landing",,\n  "settings"'));
    expect(r.errors.join('\n')).toMatch(/not valid JSON/);
  });

  it('ignores text inside style, script and comments', () => {
    const withComment = mutate('<div data-nomore-root>', '<div data-nomore-root>\n{% comment %}Notes for developers{% endcomment %}<!-- layout note -->');
    expect(lintSection(withComment).errors).toEqual([]);
  });
});
