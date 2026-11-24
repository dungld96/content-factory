import { deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

// R0 + M4a in the browser: create content (master + first variant), add a variant on the master
// page, and upload a reference image through the API into object storage.
const EDITOR = 'editor@demo.acf.test';

/** A small valid PNG (solid colour), generated here: no fixture file needed. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('editor: new content → master page → add a variant; upload a reference image', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EDITOR);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_EDITOR'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Demo Studio' }).click();

  // Create content: the API creates its master and the item as the first variant.
  await page.getByRole('main').getByRole('link', { name: 'New content' }).click();
  const form = page.getByRole('form', { name: 'New content' });
  await form.getByLabel('Title').fill('Standing desk tips');
  await form.getByLabel('Topic').fill('Three tips for using a standing desk');
  await form.getByLabel('Platform').selectOption('tiktok');
  await form.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Standing desk tips' })).toBeVisible();
  await expect(page.getByLabel('Content master')).toContainText('for TikTok');

  // The master page lists the variant; add a square YouTube variant (in a dialog).
  await page.getByLabel('Content master').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Standing desk tips' })).toBeVisible();
  const variants = page.getByRole('table', { name: 'Variants' });
  await expect(variants.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add variant' }).click();
  const variantForm = page.getByRole('form', { name: 'New variant' });
  await variantForm.getByLabel('Title (optional)').fill('Standing desk tips (Shorts)');
  await variantForm.getByLabel('Aspect ratio').selectOption('1:1');
  await variantForm.getByLabel('Platform').selectOption('youtube_shorts');
  await variantForm.getByRole('button', { name: 'Add variant' }).click();
  await expect(variants.getByRole('row')).toHaveCount(3);
  await expect(variants).toContainText('YouTube Shorts');

  // Upload a reference image from the project's asset library.
  await page.getByRole('link', { name: 'Demo Studio' }).click();
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Library' })
    .click();
  await page.getByRole('button', { name: 'Upload asset' }).click();
  const upload = page.getByRole('form', { name: 'Upload asset' });
  await expect(upload.getByLabel('Project')).toHaveValue(/.+/);
  await upload.getByLabel('Reference image').setInputFiles({
    name: 'desk-reference.png',
    mimeType: 'image/png',
    buffer: png(40, 60),
  });
  await upload.getByRole('button', { name: 'Upload' }).click();
  const refs = page.getByRole('list', { name: 'Assets' });
  await expect(refs).toContainText('desk-reference.png');
  const img = refs.getByRole('img', { name: 'desk-reference.png' });
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});
