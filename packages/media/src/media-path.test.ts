// Paths inside FFmpeg filter graphs and the concat list (Windows work directories, issue of
// 2026-11-21: `pnpm media:selftest` refused `C:\Users\...\Temp\acf-render-selftest-…`).
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { filterOptionPath, plainMediaPath, RenderInputError } from './render.js';

const win = 'C:\\Users\\ADMIN\\AppData\\Local\\Temp\\acf-render-selftest-r77thf';

describe('plainMediaPath', () => {
  it('accepts a Windows temp directory and uses forward slashes', () => {
    expect(plainMediaPath(win, path.win32)).toBe(
      'C:/Users/ADMIN/AppData/Local/Temp/acf-render-selftest-r77thf',
    );
  });

  it('keeps POSIX paths as they are', () => {
    expect(plainMediaPath('/tmp/acf-render-x/a.mp4', path.posix)).toBe('/tmp/acf-render-x/a.mp4');
  });

  it.each([
    ['C:\\Users\\Nguyễn Văn\\Temp', path.win32],
    ['C:\\Program Files\\x', path.win32],
    ["/tmp/a'b", path.posix],
    ['/tmp/a:b', path.posix],
    ['/tmp/a,b[c]', path.posix],
  ])('refuses %s', (p, api) => {
    expect(() => plainMediaPath(p, api)).toThrow(RenderInputError);
  });
});

describe('filterOptionPath', () => {
  it('escapes the drive colon for the filter graph and option parsers', () => {
    expect(filterOptionPath(`${win}\\captions.ass`, path.win32)).toBe(
      'C\\\\:/Users/ADMIN/AppData/Local/Temp/acf-render-selftest-r77thf/captions.ass',
    );
  });

  it('leaves POSIX paths unescaped', () => {
    expect(filterOptionPath('/tmp/w/captions.ass', path.posix)).toBe('/tmp/w/captions.ass');
  });
});
