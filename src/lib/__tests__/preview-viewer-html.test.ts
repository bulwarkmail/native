import { describe, it, expect } from 'vitest';
import { imageViewerHtml, mediaViewerHtml, relativeFileUrl, type ViewerColors } from '../preview-viewer-html';

const COLORS: ViewerColors = { scheme: 'dark', background: '#111', text: '#eee', textMuted: '#999', surface: '#222' };
const HOSTILE = `x"><script>alert(1)</script>'.png`;

describe('relativeFileUrl', () => {
  it('encodes everything a URL or an attribute could read as syntax', () => {
    expect(relativeFileUrl('Scan 1 (final).PNG')).toBe('Scan%201%20%28final%29.PNG');
    expect(relativeFileUrl('a#b?c%d.jpg')).toBe('a%23b%3Fc%25d.jpg');
    expect(relativeFileUrl(HOSTILE)).not.toMatch(/["'<>]/);
  });
});

describe('viewer pages', () => {
  it('load the file by a relative URL next to the page', () => {
    expect(imageViewerHtml('photo 1.jpg', COLORS)).toContain('src="photo%201.jpg"');
    expect(mediaViewerHtml('video', 'clip.mp4', COLORS)).toContain('<video id="m" src="clip.mp4"');
    expect(mediaViewerHtml('audio', 'song.mp3', COLORS)).toContain('<audio id="m" src="song.mp3"');
  });

  it('never put a file name into markup unescaped', () => {
    for (const html of [
      imageViewerHtml(HOSTILE, COLORS),
      mediaViewerHtml('video', HOSTILE, COLORS),
      mediaViewerHtml('audio', HOSTILE, COLORS),
    ]) {
      expect(html).not.toContain('<script>alert(1)');
      expect(html.match(/<script>/g)).toHaveLength(1);
    }
  });

  it('report a file that does not decode', () => {
    expect(imageViewerHtml('a.svg', COLORS)).toContain("addEventListener('error'");
    expect(mediaViewerHtml('audio', 'a.ogg', COLORS)).toContain("report('error')");
  });

  it('draw the WebView controls in the app theme, and video on black', () => {
    expect(mediaViewerHtml('audio', 'a.mp3', COLORS)).toContain('color-scheme:dark');
    expect(mediaViewerHtml('audio', 'a.mp3', { ...COLORS, scheme: 'light' })).toContain('color-scheme:light');
    expect(mediaViewerHtml('video', 'a.mp4', { ...COLORS, scheme: 'light' })).toContain('color-scheme:dark');
  });
});
