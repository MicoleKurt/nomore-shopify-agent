import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readFile, writeFile } from 'node:fs/promises';

export interface Band {
  fromY: number;
  toY: number;
  diffPercent: number;
}

export interface CompareResult {
  originalHeight: number;
  previewHeight: number;
  heightDelta: number;
  diffPercent: number;
  bands: Band[];
  worstBand: Band;
  diffPng: Buffer;
  chunks: Buffer[];
}

function pad(img: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, width), Math.min(img.height, height), 0, 0);
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pixel-diff two same-width mobile screenshots; the shorter one is padded white. */
export function compareImages(originalPng: Buffer, previewPng: Buffer, bandHeight = 300, chunkHeight = 1000): CompareResult {
  const a = PNG.sync.read(originalPng);
  const b = PNG.sync.read(previewPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const A = pad(a, width, height);
  const B = pad(b, width, height);
  const diff = new PNG({ width, height });
  const threshold = 0.18;
  const total = pixelmatch(A.data, B.data, diff.data, width, height, { threshold, includeAA: false });

  const bands: Band[] = [];
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y);
    const ba = new PNG({ width, height: h });
    const bb = new PNG({ width, height: h });
    PNG.bitblt(A, ba, 0, y, width, h, 0, 0);
    PNG.bitblt(B, bb, 0, y, width, h, 0, 0);
    const bd = new PNG({ width, height: h });
    const n = pixelmatch(ba.data, bb.data, bd.data, width, h, { threshold, includeAA: false });
    bands.push({ fromY: y, toY: y + h, diffPercent: round((n / (width * h)) * 100) });
  }
  const worstBand = bands.reduce((m, x) => (x.diffPercent > m.diffPercent ? x : m), bands[0]!);

  // Side-by-side strips: original | preview | diff, cut into chunks a model can read.
  const chunks: Buffer[] = [];
  for (let y = 0; y < height; y += chunkHeight) {
    const h = Math.min(chunkHeight, height - y);
    const strip = new PNG({ width: width * 3 + 20, height: h });
    strip.data.fill(255);
    PNG.bitblt(A, strip, 0, y, width, h, 0, 0);
    PNG.bitblt(B, strip, 0, y, width, h, width + 10, 0);
    PNG.bitblt(diff, strip, 0, y, width, h, width * 2 + 20, 0);
    chunks.push(PNG.sync.write(strip));
  }

  return {
    originalHeight: a.height,
    previewHeight: b.height,
    heightDelta: b.height - a.height,
    diffPercent: round((total / (width * height)) * 100),
    bands,
    worstBand,
    diffPng: PNG.sync.write(diff),
    chunks,
  };
}

export async function compareFiles(originalPath: string, previewPath: string): Promise<CompareResult> {
  return compareImages(await readFile(originalPath), await readFile(previewPath));
}

export async function writeCompareArtifacts(result: CompareResult, dir: string, tag: string): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < result.chunks.length; i++) {
    const f = `${dir}/compare-${tag}-${i + 1}.png`;
    await writeFile(f, result.chunks[i]!);
    files.push(f);
  }
  return files;
}
