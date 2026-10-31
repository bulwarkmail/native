import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPauseAnimatedImagesScript, IS_ANIMATED_SOURCE, MAIL_REDUCED_MOTION_CSS, withReducedMotion } from '../mail-motion';

// The app follows the system's reduce motion, but mail kept its CSS
// animations and moving GIFs (webmail 24a13cc1f, bb7869798).

const isAnimated = new Function(`${IS_ANIMATED_SOURCE}; return isAnimatedImageData;`)() as (b: Uint8Array) => boolean;

function gif(frames: number): Uint8Array {
  const head = [...'GIF89a'].map((ch) => ch.charCodeAt(0));
  const screen = [1, 0, 1, 0, 0, 0, 0]; // 1x1, no global colour table
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0]; // descriptor, LZW size, one sub-block, end
  const extension = [0x21, 0xf9, 4, 0, 0, 0, 0, 0]; // graphic control extension
  const body: number[] = [];
  for (let i = 0; i < frames; i++) body.push(...extension, ...frame);
  return new Uint8Array([...head, ...screen, ...body, 0x3b]);
}

function png(chunks: string[]): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const type of chunks) out.push(0, 0, 0, 0, ...[...type].map((ch) => ch.charCodeAt(0)), 0, 0, 0, 0);
  return new Uint8Array(out);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('reduce motion in mail', () => {
  it('tells animated GIF, APNG and WebP from still images', () => {
    expect(isAnimated(gif(2))).toBe(true);
    expect(isAnimated(gif(1))).toBe(false);
    expect(isAnimated(png(['IHDR', 'acTL', 'IDAT']))).toBe(true);
    expect(isAnimated(png(['IHDR', 'IDAT']))).toBe(false);
    const webp = (flags: number) => new Uint8Array([...'RIFF\0\0\0\0WEBPVP8X'].map((ch) => ch.charCodeAt(0)).concat([0, 0, 0, 0, flags, 0, 0, 0]));
    expect(isAnimated(webp(0x02))).toBe(true);
    expect(isAnimated(webp(0x00))).toBe(false);
  });

  it('stops CSS animations in the body', () => {
    const html = withReducedMotion('<html><body><p>hi</p></body></html>');
    expect(html).toContain(`<style data-bulwark-reduced-motion>${MAIL_REDUCED_MOTION_CSS}</style></body>`);
    expect(MAIL_REDUCED_MOTION_CSS).toContain('animation-duration:0.01ms!important');
  });

  it('swaps an animated image for a still frame with a Play button, and plays it on tap', () => {
    const made: FakeEl[] = [];
    let clickHandler: ((e: unknown) => void) | null = null;
    class FakeEl {
      attrs = new Map<string, string>();
      children: FakeEl[] = [];
      parentNode: FakeEl | null = null;
      textContent = '';
      type = '';
      width = 0;
      height = 0;
      naturalWidth = 10;
      complete = true;
      style = { props: new Map<string, string>(), width: '', setProperty(k: string, v: string) { this.props.set(k, v); }, removeProperty(k: string) { this.props.delete(k); } };
      constructor(public tagName: string) { made.push(this); }
      get parentElement() { return this.parentNode; }
      setAttribute(k: string, v: string) { this.attrs.set(k, v); }
      getAttribute(k: string) { return this.attrs.get(k) ?? null; }
      hasAttribute(k: string) { return this.attrs.has(k); }
      appendChild(c: FakeEl) { c.parentNode?.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); }
      insertBefore(c: FakeEl, ref: FakeEl) { c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); }
      getBoundingClientRect() { return { width: 10 }; }
      getContext() { return { drawImage: () => undefined }; }
      addEventListener() { /* loaded already */ }
      querySelector(sel: string) { return this.children.find((c) => (sel.startsWith('canvas') ? c.tagName === 'CANVAS' : c.tagName === 'IMG')) ?? null; }
      closest(sel: string) { return sel.startsWith('button') && this.tagName === 'BUTTON' ? this : null; }
    }
    const body = new FakeEl('BODY');
    const moving = new FakeEl('IMG');
    moving.setAttribute('src', `data:image/gif;base64,${base64(gif(3))}`);
    const still = new FakeEl('IMG');
    still.setAttribute('src', `data:image/gif;base64,${base64(gif(1))}`);
    body.appendChild(moving);
    body.appendChild(still);
    const document = {
      body,
      head: new FakeEl('HEAD'),
      createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
      querySelectorAll: () => [moving, still],
      addEventListener: (_: string, fn: (e: unknown) => void) => { clickHandler = fn; },
    };
    const atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
    new Function('document', 'atob', 'URL', buildPauseAnimatedImagesScript({ play: 'Play animation', pause: 'Pause animation' }))(document, atob, URL);

    const wrap = body.children[0];
    expect(wrap.tagName).toBe('SPAN');
    const [button, canvas, img] = wrap.children;
    expect(button.textContent).toBe('Play animation');
    expect(canvas.tagName).toBe('CANVAS');
    expect(img).toBe(moving);
    expect(moving.style.props.get('display')).toBe('none');
    // The single-frame GIF is left alone.
    expect(body.children[1]).toBe(still);

    const event = { target: button, preventDefault: () => undefined, stopImmediatePropagation: () => undefined };
    clickHandler!(event);
    expect(button.textContent).toBe('Pause animation');
    expect(moving.style.props.has('display')).toBe(false);
  });

  it('is applied by the body view while motion is reduced', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../../components/EmailBodyView.tsx'), 'utf8');
    expect(view).toMatch(/const reduceMotion = !useShouldAnimate\(\);/);
    expect(view).toMatch(/reduceMotion && prepared\.isHtml \? withReducedMotion\(prepared\.html\)/);
    expect(view).toMatch(/prepared\.isHtml && reduceMotion \? buildPauseAnimatedImagesScript\(pauseLabels\)/);
  });
});
