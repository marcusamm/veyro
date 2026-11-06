import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Liquid } from 'liquidjs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('site/demo-previews.json', root), 'utf8'));
const snippet = readFileSync(new URL('site/theme/snippets/demo-sources.liquid', root), 'utf8');
const liquid = new Liquid();

describe('responsive demo image delivery', () => {
  it('ships actual WebP files whose immutable filenames match their bytes', () => {
    for (const shot of Object.values(manifest.screenshots)) {
      for (const group of Object.values(shot)) {
        const source = readFileSync(new URL(`public/demo/_previews/${group.source}`, root));
        expect(source.length).toBe(group.source_bytes);
        for (const row of group.variants) {
          const image = readFileSync(new URL(`public/demo/_previews/${row.file}`, root));
          const hash = createHash('sha256').update(image).digest('hex');
          expect(image.subarray(0, 4).toString()).toBe('RIFF');
          expect(image.subarray(8, 12).toString()).toBe('WEBP');
          expect(image.length).toBe(row.bytes);
          expect(hash).toBe(row.sha256);
          expect(row.file).toContain(`.${hash.slice(0, 12)}.webp`);
          expect(row.bytes).toBeLessThan(group.source_bytes * .9);
          expect(snippet).toContain(`/demo/_previews/${row.file} ${row.width}w`);
        }
      }
    }
  });

  it('keeps wide screenshots in the scroll gallery on mobile as well as desktop', async () => {
    const html = await liquid.parseAndRender(snippet, { shot: 'holm-tomrer', sizes: '88vw' });
    expect(html.match(/<source/g)).toHaveLength(1);
    expect(html).not.toContain('media=');
    expect(html).not.toContain('-mobil-');
    expect(html).toContain('480w');
    expect(html).toContain('1920w');
    expect(html).toContain('sizes="88vw"');
  });

  it('retains the mobile crop with matching breakpoint and aspect ratio', async () => {
    const html = await liquid.parseAndRender(snippet, { shot: 'salon-nord-booking', mobile: true, mobile_breakpoint: '499px', desktop_breakpoint: '500px', sizes: '90vw' });
    expect(html.match(/<source/g)).toHaveLength(2);
    expect(html).toContain('media="(max-width: 499px)"');
    expect(html).toContain('media="(min-width: 500px)"');
    expect(html).toContain('width="780" height="1280"');
    expect(html).toContain('width="1920" height="1200"');
  });

  it('leaves the more efficient ceramic JPEG mobile fallback reachable', async () => {
    const html = await liquid.parseAndRender(snippet, { shot: 'lervaerk-kurv', mobile: true, sizes: '90vw' });
    expect(html.match(/<source/g)).toHaveLength(1);
    expect(html).toContain('media="(min-width: 600px)"');
    expect(html).not.toContain('srcset=""');
  });
});
