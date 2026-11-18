import { expect, test, type Page } from '@playwright/test';

// The script → storyboard pipeline end to end: web → API → BullMQ → worker → fixture LLM
// (no network, no cost) → PostgreSQL → web. Runs against the seeded demo workspace.
const EDITOR = 'editor@demo.acf.test';
const VIEWER = 'viewer@demo.acf.test';
const passwordOf = (who: 'EDITOR' | 'VIEWER') => process.env[`E2E_PASSWORD_${who}`] ?? '';
const GENERATION_TIMEOUT = 30_000;

async function openDemoContent(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.getByRole('link', { name: 'Demo Studio' }).click();
  await page
    .getByRole('list', { name: 'Content items' })
    .getByRole('link', { name: '5 useful desk gadgets' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: '5 useful desk gadgets' }),
  ).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('editor: brief → script → edit → approve → storyboard → scene edit → approve', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDemoContent(page, EDITOR, passwordOf('EDITOR'));
  await expect(page.getByText('Brief ready')).toBeVisible();

  // Gate 0: generate the script (async job processed by the worker).
  await page.getByRole('button', { name: 'Generate script' }).click();
  const v1 = page.getByRole('article', { name: 'Script version 1' });
  await expect(v1).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await expect(v1).toContainText('Pending review');
  await expect(page.getByLabel('Content status')).toHaveText('script_review');

  // An edit never changes v1: it creates v2.
  await page.getByRole('button', { name: 'Edit script' }).click();
  const form = page.getByRole('form', { name: 'Edit script' });
  await form.getByLabel('Hook').fill('Five desk upgrades you will use every single day');
  await form.getByRole('button', { name: 'Save as new version' }).click();
  const v2 = page.getByRole('article', { name: 'Script version 2' });
  await expect(v2).toContainText('Five desk upgrades you will use every single day');
  await expect(v2).toContainText('Edited');

  // Gate 1: approve the script.
  await v2.getByRole('button', { name: 'Approve script' }).click();
  await expect(v2).toContainText('Approved');
  await expect(v2).toContainText('In use');
  await expect(page.getByLabel('Content status')).toHaveText('script_review');

  // Storyboard from the approved script.
  await page.getByRole('button', { name: 'Generate storyboard' }).click();
  const s1 = page.getByRole('article', { name: 'Storyboard version 1' });
  await expect(s1).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await expect(s1.getByRole('table', { name: 'Scenes' }).getByRole('row')).not.toHaveCount(1);
  await expect(page.getByLabel('Content status')).toHaveText('storyboard_review');

  // A scene edit creates storyboard v2.
  await s1.getByRole('button', { name: 'Edit scene 1' }).click();
  const sceneForm = page.getByRole('form', { name: 'Edit scene 1' });
  await sceneForm.getByLabel('Image prompt').fill('Close-up of a walnut monitor stand, soft light');
  await sceneForm.getByRole('button', { name: 'Save as new version' }).click();
  const s2 = page.getByRole('article', { name: 'Storyboard version 2' });
  await expect(s2).toContainText('Close-up of a walnut monitor stand, soft light');

  // Gate 2: approve the storyboard.
  await s2.getByRole('button', { name: 'Approve storyboard' }).click();
  await expect(s2).toContainText('Approved');
  await expect(page.getByLabel('Content status')).toHaveText('storyboard_review');

  // A reload shows the persisted state.
  await page.reload();
  await expect(page.getByRole('article', { name: 'Storyboard version 2' })).toContainText('In use');
});

test('viewer: sees the versions but no generate, edit or review controls', async ({ page }) => {
  await openDemoContent(page, VIEWER, passwordOf('VIEWER'));
  await expect(page.getByRole('article', { name: 'Script version 2' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Storyboard version 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Generate/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Edit|Approve|Reject/ })).toHaveCount(0);
});
