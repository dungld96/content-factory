import { expect, test } from '@playwright/test';

// Archive ("delete") and restore in the browser: nothing is removed, the item leaves the lists
// and comes back from Productions › Archived; a master waits for its variants.
const EDITOR = 'editor@demo.acf.test';
const TITLE = 'Archive me';

test('editor: archive a content item, find it under Archived, restore it', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EDITOR);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_EDITOR'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);

  await page.goto('/productions/new');
  const form = page.getByRole('form', { name: 'New content' });
  await form.getByLabel('Title').fill(TITLE);
  await form.getByLabel('Topic').fill('An item made to be archived');
  await form.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();

  // The master cannot be archived while this variant is active.
  await page.getByRole('tab', { name: /^Brief/ }).click();
  await page.getByLabel('Content master').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  const masterUrl = page.url();
  await page
    .getByRole('button', { name: `Archive ${TITLE}` })
    .first()
    .click();
  const masterDialog = page.getByRole('dialog', { name: `Archive “${TITLE}”?` });
  await expect(masterDialog).toContainText('1 variant is still active');
  await expect(masterDialog.getByRole('button', { name: 'Archive' })).toBeDisabled();
  await masterDialog.getByRole('button', { name: 'Keep' }).click();

  // Archive the item from its page: it asks first, then leaves Productions.
  await page.getByRole('table', { name: 'Variants' }).getByRole('link', { name: TITLE }).click();
  await expect(page).toHaveURL(/\/content\//);
  await page.getByRole('button', { name: `Archive ${TITLE}` }).click();
  const dialog = page.getByRole('dialog', { name: `Archive “${TITLE}”?` });
  await expect(dialog).toContainText('Nothing is deleted');
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(page).toHaveURL(/\/productions$/);
  const table = page.getByRole('table', { name: 'Content items' });
  await expect(table.getByRole('link', { name: TITLE })).toHaveCount(0);

  // Productions › Archived lists it with Restore.
  await page.getByRole('link', { name: /^Archived/ }).click();
  const archived = page.getByRole('row', { name: new RegExp(TITLE) });
  await expect(archived).toBeVisible();
  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(`“${TITLE}” restored.`)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toHaveCount(0);

  // Back in the active list, and the master can still be opened.
  await page.goto('/productions');
  await expect(page.getByRole('link', { name: TITLE }).first()).toBeVisible();
  await page.goto(masterUrl);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
});
