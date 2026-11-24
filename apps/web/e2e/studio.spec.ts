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

test('owner: To-do, search, Productions list and board, masters and asset lineage', async ({
  page,
}) => {
  await signIn(page);

  // To-do (R2): the queue of decisions; the exported demo item is ready to download.
  await expect(page.getByRole('heading', { level: 1, name: /need(s)? you/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Decisions waiting' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ready to download' })).toContainText(
    '5 useful desk gadgets',
  );
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(7);

  // ⌘K / Ctrl+K focuses the search; Enter opens the filtered Productions list.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('searchbox', { name: 'Search content' })).toBeFocused();
  await page.keyboard.type('desk gadgets');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/productions\?q=desk(\+|%20)gadgets$/);
  const library = page.getByRole('table', { name: 'Content items' });
  await expect(library).toContainText('5 useful desk gadgets');
  await expect(library).not.toContainText('Standing desk tips');

  // The former content library address redirects, with its query (R1).
  await page.goto('/content?status=approved');
  await expect(page).toHaveURL(/\/productions\?status=approved$/);
  await expect(library).toContainText('5 useful desk gadgets');
  await expect(library).not.toContainText('Standing desk tips');

  // Status filter (URL-backed): the pipeline spec exported the demo item.
  await page.goto('/productions?status=approved');
  await expect(library).toContainText('5 useful desk gadgets');

  // The board view groups items by stage; /pipeline redirects to it.
  await page.goto('/pipeline');
  await expect(page).toHaveURL(/\/productions\?view=board$/);
  await expect(page.getByRole('region', { name: 'Done' })).toContainText('5 useful desk gadgets');
  await expect(page.getByRole('region', { name: 'Render', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft', exact: true })).toContainText(
    'Standing desk tips',
  );

  // Content masters list (from Productions).
  await page.getByRole('link', { name: 'Content masters' }).click();
  await expect(page.getByRole('table', { name: 'Content masters' })).toContainText(
    'Standing desk tips',
  );

  // Library: lineage of the uploaded reference and of a generated image.
  await nav(page, 'Library').click();
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
  // Wait for the filtered list before clicking (the previous list is still on screen briefly).
  const render = assets.getByRole('button', { name: /^\d+ s\s*Render\b|^Render\b/ });
  await expect(render).toHaveCount(1);
  await render.click();
  await expect(lineage).toContainText('local/ffmpeg-render');
  await expect(lineage).toContainText('Job cost$0');
});

test('owner: project settings and a new project', async ({ page }) => {
  await signIn(page);

  // System status has its own Settings section.
  await page.goto('/settings?section=system');
  await expect(page.getByRole('region', { name: 'Dependencies' })).toContainText('Database');

  // Owners edit the project profile (General, the default section); the change is persisted.
  await nav(page, 'Settings').click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
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

test('owner: switches the interface to Vietnamese and back (R-D6)', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /Account menu/ }).click();
  const switcher = page.getByRole('group', { name: 'Interface language' });
  await switcher.getByRole('button', { name: 'VI' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { level: 1, name: /cần bạn/ })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Chính' }).getByRole('link', { name: 'Sản xuất' }),
  ).toBeVisible();
  // Saved on the account: a fresh page (and another device) renders in Vietnamese from the start.
  await page.context().clearCookies({ name: 'acf_locale' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { level: 1, name: /cần bạn/ })).toBeVisible();
  // Settings › Profile & language: follow the browser again (English here).
  await page.goto('/settings/profile');
  await page.getByRole('radio', { name: 'Theo trình duyệt' }).check();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('phone (390 px): bottom bar and no horizontal scroll, in both languages (R7)', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page);
  const bar = page.getByRole('navigation', { name: 'Menu' });
  await expect(bar.getByRole('link')).toHaveCount(4);
  await expect(bar.getByRole('button', { name: 'Menu' })).toBeVisible();
  const pages = [
    '/',
    '/productions',
    '/productions?view=board',
    '/projects',
    '/assets',
    '/costs',
    '/operations',
    '/settings/general',
  ];
  for (const locale of ['en', 'vi'] as const) {
    await context.addCookies([
      { name: 'acf_locale', value: locale, domain: 'localhost', path: '/' },
    ]);
    for (const path of pages) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${locale} ${path}`).toBeLessThanOrEqual(0);
    }
  }
  await context.close();
});
