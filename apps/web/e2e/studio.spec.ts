import { expect, test, type Page } from '@playwright/test';

// M4.5 workspace pages against real data. Runs after masters.spec and pipeline.spec (files run
// in name order, one worker), so the demo content has generated images and a second item.
const OWNER = 'owner@demo.acf.test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_OWNER'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
}

const nav = (page: Page, name: string) =>
  page.getByRole('complementary').getByRole('link', { name, exact: true });

test('owner: overview, search, filters, pipeline board, masters and asset lineage', async ({
  page,
}) => {
  await signIn(page);

  // Overview: counts and the recent list come from the API.
  const stats = page.getByRole('region', { name: 'Workspace statistics' });
  await expect(stats).toContainText('Content items');
  await expect(page.getByRole('table', { name: 'Recently updated' })).toContainText(
    '5 useful desk gadgets',
  );

  // ⌘K / Ctrl+K focuses the search; Enter opens the filtered content library.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('searchbox', { name: 'Search content' })).toBeFocused();
  await page.keyboard.type('desk gadgets');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/content\?q=desk(\+|%20)gadgets$/);
  const library = page.getByRole('table', { name: 'Content items' });
  await expect(library).toContainText('5 useful desk gadgets');
  await expect(library).not.toContainText('Standing desk tips');

  // Status filter (URL-backed): the pipeline spec exported the demo item.
  await page.goto('/content');
  await page.getByLabel('Status').selectOption({ label: 'Approved or exported' });
  await expect(page).toHaveURL(/status=approved/);
  await expect(library).toContainText('5 useful desk gadgets');
  await expect(library).not.toContainText('Standing desk tips');

  // Pipeline board groups items by stage.
  await nav(page, 'Production pipeline').click();
  await expect(page.getByRole('region', { name: 'Approved' })).toContainText(
    '5 useful desk gadgets',
  );
  await expect(page.getByRole('region', { name: 'Render & quality' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft' })).toContainText('Standing desk tips');

  // Content masters list.
  await nav(page, 'Content masters').click();
  await expect(page.getByRole('table', { name: 'Content masters' })).toContainText(
    'Standing desk tips',
  );

  // Asset library: lineage of the uploaded reference and of a generated image.
  await nav(page, 'Asset library').click();
  const assets = page.getByRole('list', { name: 'Assets' });
  await assets.getByRole('button', { name: /desk-reference\.png/ }).click();
  const lineage = page.getByRole('region', { name: 'Asset lineage' });
  await expect(lineage).toContainText('Uploaded reference');
  await expect(lineage).toContainText('Nothing (original asset)');

  await page.getByLabel('Asset type').selectOption({ label: 'Generated images' });
  await expect(page).toHaveURL(/type=image/);
  await expect(assets.getByRole('button', { name: /desk-reference\.png/ })).toHaveCount(0);
  // A scene image (the render's thumbnail is also a generated image, made by the renderer).
  await assets
    .getByRole('button', { name: /^Scene 1/ })
    .first()
    .click();
  await expect(lineage).toContainText('Generated image');
  await expect(lineage).toContainText('mock/solid-image');
  await expect(lineage).toContainText('Open content workspace');

  // Renders (M6) are listed with their lineage: the local renderer, no provider cost.
  await page.getByLabel('Asset type').selectOption({ label: 'Renders' });
  await assets.getByRole('button').first().click();
  await expect(lineage).toContainText('local/ffmpeg-render');
  await expect(lineage).toContainText('Job cost$0');
});

test('owner: project settings and a new project', async ({ page }) => {
  await signIn(page);

  // Owners edit the project profile; the change is persisted and shown everywhere.
  await nav(page, 'Settings').click();
  await expect(page.getByRole('region', { name: 'System status' })).toContainText('database');
  const settings = page.getByRole('form', { name: 'Project settings' });
  await settings.getByLabel('Project name').fill('Demo Studio HQ');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Project settings saved.' }),
  ).toBeVisible();
  await nav(page, 'Projects').click();
  await expect(page.getByRole('list', { name: 'Your projects' })).toContainText('Demo Studio HQ');
  // Restore the seeded name.
  await nav(page, 'Settings').click();
  await settings.getByLabel('Project name').fill('Demo Studio');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Project settings saved.' }),
  ).toBeVisible();

  // Create a project from the dialog: the slug follows the name.
  await nav(page, 'Projects').click();
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Name').fill('Pilot Channel');
  await expect(form.getByLabel(/^Slug/)).toHaveValue('pilot-channel');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pilot Channel' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Content items' })).toHaveCount(0);
  await expect(page.getByText('No content items yet')).toBeVisible();
});
