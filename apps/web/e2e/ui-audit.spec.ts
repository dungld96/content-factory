import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// Layout and runtime audit of every studio page: desktop and phone, English and Vietnamese.
// Runs last (file name order, one worker), so earlier specs have created content, masters,
// generated media and renders. Per page it fails on: horizontal page overflow, visible elements
// pushed off-screen, text clipped without an ellipsis, broken images, uncaught errors, console
// errors and server errors (5xx). Every finding is listed in test-results/ui-audit.json.
const OWNER = 'owner@demo.acf.test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(process.env['E2E_PASSWORD_OWNER'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
}

interface Finding {
  readonly viewport: string;
  readonly locale: string;
  readonly url: string;
  readonly issues: string[];
}

/** Runs in the page: layout problems a user would see. */
function layoutIssues(): string[] {
  const issues: string[] = [];
  const width = document.documentElement.clientWidth;
  const overflow = document.documentElement.scrollWidth - width;
  if (overflow > 1) issues.push(`page scrolls horizontally by ${String(overflow)}px`);
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  const inScroller = (el: Element): boolean => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
    }
    return false;
  };
  const hidden = (el: Element): boolean =>
    el.closest('.sr-only, [aria-hidden="true"], [hidden], dialog:not([open])') !== null;
  const offscreen: string[] = [];
  const clipped: string[] = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || hidden(el)) continue;
    if ((r.right > width + 1 || r.left < -1) && !inScroller(el)) offscreen.push(describe(el));
    const text = (el.textContent || '').trim();
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim(),
    );
    if (
      ownText &&
      text.length > 0 &&
      el.scrollWidth > el.clientWidth + 1 &&
      /(hidden|clip)/.test(s.overflowX) &&
      s.textOverflow !== 'ellipsis' &&
      !['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(el.tagName)
    ) {
      clipped.push(describe(el));
    }
  }
  // A child sticking out of its box (e.g. a long label past a card's border).
  const spill: string[] = [];
  for (const el of document.querySelectorAll('body *')) {
    const parent = el.parentElement;
    if (!parent || hidden(el)) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') continue;
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX)) continue;
    const r = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    if (r.width === 0 || p.width === 0) continue;
    if (r.right > p.right + 2 || r.left < p.left - 2) spill.push(describe(el));
  }
  if (spill.length) issues.push(`sticks out of its box: ${spill.slice(0, 5).join(' | ')}`);
  // Side scrolling that is not part of the design (boards, tab strips and wide tables scroll).
  const scrollers = [...document.querySelectorAll('body *')].filter((el) => {
    const s = getComputedStyle(el);
    return (
      /(auto|scroll)/.test(s.overflowX) &&
      el.scrollWidth > el.clientWidth + 1 &&
      !el.matches(
        '.board, .board *, .seg, .tabs, .rail, .stage-rail, .chips, .kf-strip, .page-tabs, .table-box',
      ) &&
      !(el.classList.contains('table-wrap') && !el.querySelector('.stack-mobile'))
    );
  });
  if (scrollers.length)
    issues.push(`scrolls sideways: ${scrollers.slice(0, 5).map(describe).join(' | ')}`);
  if (offscreen.length) issues.push(`off-screen: ${offscreen.slice(0, 5).join(' | ')}`);
  if (clipped.length) issues.push(`clipped text: ${clipped.slice(0, 5).join(' | ')}`);
  const broken = [...document.images].filter((i) => i.complete && i.src && i.naturalWidth === 0);
  if (broken.length)
    issues.push(`broken images: ${broken.map((i) => i.src.slice(-50)).join(', ')}`);
  const body = document.body.innerText;
  const odd = /\b(undefined|NaN)\b|\[object Object\]/.exec(body);
  if (odd)
    issues.push(
      `suspicious text near "${body.slice(Math.max(0, odd.index - 30), odd.index + 20)}"`,
    );
  return issues;
}

test('every page lays out without overflow or errors (desktop and phone, EN and VI)', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  await signIn(page);

  // Ids for the detail pages, from the API through the same-origin proxy.
  const projects = (await (await page.request.get('/api/v1/projects?limit=5')).json()) as {
    data: { id: string }[];
  };
  const projectId = projects.data[0]?.id;
  expect(projectId).toBeTruthy();
  const content = (await (
    await page.request.get(`/api/v1/projects/${projectId ?? ''}/content?limit=20`)
  ).json()) as { data: { id: string }[] };
  const masters = (await (
    await page.request.get(`/api/v1/projects/${projectId ?? ''}/content-masters?limit=5`)
  ).json()) as { data: { id: string }[] };

  const urls = [
    '/',
    '/productions',
    '/productions?view=board',
    '/productions/new',
    '/projects',
    `/projects/${projectId ?? ''}`,
    `/projects/${projectId ?? ''}/brand`,
    `/projects/${projectId ?? ''}/costs`,
    ...content.data.slice(0, 3).map((c) => `/content/${c.id}`),
    // Every stage panel of one item: only the active one is shown, the others are hidden.
    ...content.data
      .slice(0, 1)
      .flatMap((c) =>
        ['brief', 'script', 'storyboard', 'scenes', 'render', 'export'].map(
          (s) => `/content/${c.id}#${s}`,
        ),
      ),
    '/masters',
    ...masters.data.slice(0, 1).map((m) => `/masters/${m.id}`),
    '/assets',
    '/costs',
    '/operations',
    '/status',
    ...['general', 'profile', 'budgets', 'voices', 'ai', 'models', 'activity', 'system'].map(
      (s) => `/settings/${s}`,
    ),
  ];

  const runtime: string[] = [];
  page.on('pageerror', (e) => runtime.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') runtime.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) runtime.push(`HTTP ${String(r.status())} ${new URL(r.url()).pathname}`);
  });

  const findings: Finding[] = [];
  for (const [viewport, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const locale of ['en', 'vi'] as const) {
      await context.addCookies([
        { name: 'acf_locale', value: locale, domain: 'localhost', path: '/' },
      ]);
      for (const url of urls) {
        runtime.length = 0;
        await page.goto(url);
        await page.waitForLoadState('load');
        // Live updates keep a stream open (no network idle): let client data settle.
        await page.waitForTimeout(500);
        const issues = [...(await page.evaluate(layoutIssues)), ...runtime];
        if (issues.length) findings.push({ viewport, locale, url, issues });
      }
    }
  }

  writeFileSync(
    path.join(process.cwd(), 'test-results', 'ui-audit.json'),
    JSON.stringify(findings, null, 2),
  );
  expect(
    findings,
    findings
      .map((f) => `${f.viewport} ${f.locale} ${f.url}\n  - ${f.issues.join('\n  - ')}`)
      .join('\n'),
  ).toEqual([]);
});
