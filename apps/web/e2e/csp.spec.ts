import { expect, test, type Page } from '@playwright/test';

// M8.5 Q8: every page carries a nonce-based Content-Security-Policy and loads without a single
// CSP violation (Next.js scripts, self-hosted fonts, inline style attributes, media).
const OWNER = 'owner@demo.acf.test';

function watchViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to (load|execute|apply)/i.test(msg.text())) {
      violations.push(`${page.url()}: ${msg.text()}`);
    }
  });
  return violations;
}

async function visit(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp, path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp, path).toContain("frame-ancestors 'none'");
  expect(csp, path).not.toContain('unsafe-eval');
  await page.waitForLoadState('networkidle');
}

test('pages send a CSP with a nonce and raise no violations', async ({ page }) => {
  test.setTimeout(90_000);
  const violations = watchViolations(page);

  await visit(page, '/login');
  await visit(page, '/status');
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_OWNER'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);

  for (const path of [
    '/',
    '/projects',
    '/content',
    '/masters',
    '/assets',
    '/pipeline',
    '/operations',
    '/settings',
  ]) {
    await visit(page, path);
  }

  // Detail pages: the first project and content item linked from the lists.
  await visit(page, '/projects');
  const project = await page.locator('a[href^="/projects/"]').first().getAttribute('href');
  if (project) {
    await visit(page, project);
    await visit(page, `${project}/costs`);
  }
  await visit(page, '/content');
  const content = await page.locator('a[href^="/content/"]').first().getAttribute('href');
  if (content) await visit(page, content);

  // The nonce changes per request and the scripts on the page carry it.
  const first = await page.request.get('/login');
  const second = await page.request.get('/login');
  const nonceOf = (h: string | undefined) => /'nonce-([^']+)'/.exec(h ?? '')?.[1];
  expect(nonceOf(first.headers()['content-security-policy'])).not.toBe(
    nonceOf(second.headers()['content-security-policy']),
  );
  const nonce = nonceOf(second.headers()['content-security-policy']) ?? '';
  expect(await second.text()).toContain(`nonce="${nonce}"`);

  expect(violations).toEqual([]);
});
