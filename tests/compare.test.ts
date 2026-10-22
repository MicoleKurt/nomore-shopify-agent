import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareImages } from '../src/compare.js';

function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('compareImages', () => {
  it('reports 0% for identical images', () => {
    const a = solid(390, 900, [255, 255, 255]);
    const r = compareImages(a, a);
    expect(r.diffPercent).toBe(0);
    expect(r.heightDelta).toBe(0);
    expect(r.worstBand.diffPercent).toBe(0);
  });

  it('reports 100% for completely different colors', () => {
    const r = compareImages(solid(390, 600, [255, 255, 255]), solid(390, 600, [0, 0, 0]));
    expect(r.diffPercent).toBe(100);
  });

  it('pads the shorter image and reports the height difference', () => {
    const r = compareImages(solid(390, 600, [255, 255, 255]), solid(390, 900, [255, 255, 255]));
    expect(r.heightDelta).toBe(300);
    expect(r.diffPercent).toBe(0);
  });

  it('finds the band that differs', () => {
    const a = PNG.sync.read(solid(390, 900, [255, 255, 255]));
    for (let y = 300; y < 600; y++) for (let x = 0; x < 390; x++) a.data[(y * 390 + x) * 4] = 0;
    const r = compareImages(solid(390, 900, [255, 255, 255]), PNG.sync.write(a));
    expect(r.worstBand.fromY).toBe(300);
    expect(r.bands.map((b) => b.diffPercent)[0]).toBe(0);
  });

  it('cuts the side-by-side strips into readable chunks', () => {
    const r = compareImages(solid(390, 2500, [255, 255, 255]), solid(390, 2500, [255, 255, 255]));
    expect(r.chunks).toHaveLength(3);
    const first = PNG.sync.read(r.chunks[0]!);
    expect(first.width).toBe(390 * 3 + 20);
    expect(first.height).toBe(1000);
  });
});
