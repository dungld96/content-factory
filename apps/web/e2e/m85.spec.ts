import { expect, test, type Page } from '@playwright/test';

// M8.5 review UX on a fresh project (the demo item belongs to the pipeline spec): model choice
// for scripts, approving an earlier script version, and the voice picker.
const OWNER = 'owner@demo.acf.test';
const GENERATION_TIMEOUT = 30_000;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_OWNER'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
}

test.describe.configure({ mode: 'serial' });

let projectUrl = '';
let contentUrl = '';

test('owner: picks a model and approves an earlier script version', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const slug = `m85-${String(Date.now())}`;
  await page.goto('/projects');
  await page
    .getByRole('button', { name: /New project/ })
    .first()
    .click();
  const project = page.getByRole('form', { name: 'New project' });
  await project.locator('[name=name]').fill('M8.5 checks');
  await project.locator('[name=slug]').fill(slug);
  await project.locator('[name=defaultLanguage]').fill('vi');
  await project.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  projectUrl = page.url();

  await page
    .getByRole('button', { name: /New content/ })
    .first()
    .click();
  const content = page.getByRole('form', { name: 'New content' });
  await content.locator('[name=title]').fill('Phin coffee tips');
  await content.locator('[name=topic]').fill('Three tips for better phin coffee at home');
  await content.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/content\/[0-9a-f-]{36}/);
  contentUrl = page.url();

  // Q3: the script panel offers the enabled text models next to the task route.
  const model = page.getByLabel('Model');
  await expect(model).toBeVisible();
  await expect(model.locator('option')).toContainText(['Default (task route)']);
  expect(await model.locator('option').count()).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Generate script' }).click();
  await expect(page.getByText(/Version 1 ·/).first()).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await page.reload();
  await page.getByRole('button', { name: 'Regenerate script' }).click();
  await expect(page.getByText(/Version 2 ·/).first()).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await page.reload();

  // Q4: version 1 is approved from the earlier-versions list while version 2 stays pending.
  await page.getByText(/Earlier versions \(1\)/).click();
  const v1 = page.getByRole('listitem', { name: 'Script version 1' });
  await v1.getByRole('button', { name: 'Approve script v1' }).click();
  await expect(page.getByText('The script v1 is approved.')).toBeVisible();
  await page.reload();
  // The stage rail names the approved version (redesign R3).
  await expect(page.getByRole('tablist', { name: 'Production stages' })).toContainText(
    'v1 approved',
  );
});

test('owner: voice picker offers the model voices', async ({ page }) => {
  await signIn(page);
  const projectId = projectUrl.split('/').pop() ?? '';
  await page.goto(`/settings/voices?project=${projectId}`);
  const form = page.getByRole('form', { name: 'New voice profile' });
  await expect(form).toBeVisible();
  // Only enabled models are offered; the voice field lists the model's voices.
  await expect(form.locator('[name=modelKey] option')).not.toContainText(['(disabled)']);
  await expect(form.locator('[name=voice]')).toHaveAttribute('list', 'voice-options');
  await expect(form.locator('#voice-options option')).not.toHaveCount(0);
  expect(contentUrl).not.toBe('');
});
