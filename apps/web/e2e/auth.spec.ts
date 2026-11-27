import { expect, test, type Page } from '@playwright/test';

const OWNER = 'owner@demo.acf.test';
const VIEWER = 'viewer@demo.acf.test';
const passwordOf = (who: 'OWNER' | 'VIEWER') => process.env[`E2E_PASSWORD_${who}`] ?? '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('unauthenticated visitors are sent to the sign-in page', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password shows a generic error and sets no session', async ({ page, context }) => {
  await signIn(page, OWNER, 'definitely-not-the-password');
  // Next.js also renders an (empty) route announcer with role="alert"; scope to the form.
  await expect(page.locator('form').getByRole('alert')).toHaveText(
    'The email or password is incorrect.',
  );
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).some((c) => c.name === 'acf_sid')).toBe(false);
});

/** The Overview at the root (`/`) is where sign-in lands. */
const OVERVIEW = /:\d+\/$/;

test('login → project list → logout', async ({ page, context }) => {
  await signIn(page, OWNER, passwordOf('OWNER'));
  await expect(page).toHaveURL(OVERVIEW);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  const projects = page.getByRole('list', { name: 'Your projects' });
  await expect(projects.getByRole('heading', { name: 'Demo Studio' })).toBeVisible();
  await expect(projects).toContainText('Owner');
  await expect(page.getByText('Demo Owner')).toBeVisible();

  const session = (await context.cookies()).find((c) => c.name === 'acf_sid');
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

  // A reload keeps the session (server-rendered with the forwarded cookie).
  await page.reload();
  await expect(projects.getByRole('heading', { name: 'Demo Studio' })).toBeVisible();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).some((c) => c.name === 'acf_sid')).toBe(false);

  // The old cookie is revoked server-side, not just deleted in the browser.
  await context.addCookies([session ?? { name: 'acf_sid', value: 'x', url: '/' }]);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});

test('sign out works after a reload (CSRF token re-fetched)', async ({ page }) => {
  await signIn(page, VIEWER, passwordOf('VIEWER'));
  await expect(page).toHaveURL(OVERVIEW);
  await page.goto('/projects');
  await expect(page.getByRole('list', { name: 'Your projects' })).toContainText('Viewer');
  await page.reload(); // drops the in-memory CSRF token
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});

test('a signed-in user visiting /login goes to the overview', async ({ page }) => {
  await signIn(page, OWNER, passwordOf('OWNER'));
  await expect(page).toHaveURL(OVERVIEW);
  await page.goto('/login');
  await expect(page).toHaveURL(OVERVIEW);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
