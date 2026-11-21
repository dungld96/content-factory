import { expect, test, type Page } from '@playwright/test';

// M7: the Costs tab with the owner's budget editor, the read-only view for editors, and the
// Operations page. Runs against the seeded demo workspace; the budget is restored at the end.
const OWNER = 'owner@demo.acf.test';
const EDITOR = 'editor@demo.acf.test';
const passwordOf = (who: 'OWNER' | 'EDITOR') => process.env[`E2E_PASSWORD_${who}`] ?? '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
}

async function openCosts(page: Page) {
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Demo Studio' }).click();
  await page.getByRole('link', { name: 'Costs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Costs and budget' })).toBeVisible();
}

async function saveBudget(page: Page, monthly: string, mode: 'hard' | 'soft') {
  const form = page.getByRole('form', { name: 'Budget limits' });
  await form.getByLabel('Monthly limit (USD)').fill(monthly);
  await form.getByLabel('Monthly mode').selectOption(mode);
  await form.getByRole('button', { name: 'Save budget' }).click();
  await expect(page.getByText('Budget saved.')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('owner: sees this month’s costs and changes the budget', async ({ page }) => {
  await signIn(page, OWNER, passwordOf('OWNER'));
  await openCosts(page);
  const budget = page.getByRole('region', { name: 'Budget' });
  await expect(budget).toContainText('This month');
  await expect(budget).toContainText('Remaining');
  await expect(page.getByRole('region', { name: 'Six-month trend' }).getByRole('link')).toHaveCount(
    6,
  );

  await saveBudget(page, '25', 'soft');
  await page.reload();
  const form = page.getByRole('form', { name: 'Budget limits' });
  await expect(form.getByLabel('Monthly limit (USD)')).toHaveValue('25');
  await expect(form.getByLabel('Monthly mode')).toHaveValue('soft');
  await expect(budget).toContainText('of $25 (soft)');

  // Invalid amounts never reach the API.
  await form.getByLabel('Per request limit (USD)').fill('two dollars');
  await form.getByRole('button', { name: 'Save budget' }).click();
  await expect(form.getByRole('alert')).toContainText('Per request: enter an amount in USD');

  // Restore the seeded default for the other specs.
  await form.getByLabel('Per request limit (USD)').fill('2');
  await saveBudget(page, '10', 'hard');
});

test('editor: sees the limits read-only', async ({ page }) => {
  await signIn(page, EDITOR, passwordOf('EDITOR'));
  await openCosts(page);
  await expect(page.getByRole('form', { name: 'Budget limits' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Budget limits' })).toContainText(
    'Only project owners change them',
  );
});

test('operations page: queues, failures, providers and budgets', async ({ page }) => {
  await signIn(page, OWNER, passwordOf('OWNER'));
  await page
    .getByRole('navigation', { name: 'Production' })
    .getByRole('link', { name: 'Operations' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Queues' })).toContainText('generation-dlq');
  await expect(page.getByRole('heading', { name: 'Held reservations' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Project budgets' })).toContainText('Demo Studio');
});
