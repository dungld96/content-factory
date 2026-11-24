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
  await expect(page).toHaveURL(/:\d+\/$/);
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Demo Studio' }).click();
  await page
    .getByRole('table', { name: 'Content items' })
    .getByRole('link', { name: '5 useful desk gadgets' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: '5 useful desk gadgets' }),
  ).toBeVisible();
}

/**
 * Opens a stage of the content workspace's stage rail (brief & script, storyboard, scenes, render
 * & export; redesign R3). Keyframes, clips and voice-over are stages inside Scenes (UX review U1).
 */
async function openTab(page: Page, name: RegExp) {
  if (/Keyframes|Clips|Voice-over/.test(name.source)) {
    await page.getByRole('tab', { name: /^Scenes/ }).click();
  }
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

test.describe.configure({ mode: 'serial' });

test('editor: brief → script → edit → approve → storyboard → scene edit → approve', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDemoContent(page, EDITOR, passwordOf('EDITOR'));
  // The brief and its check are the first stage of the rail.
  await openTab(page, /^Brief/);
  await expect(page.getByText('Brief ready')).toBeVisible();
  await openTab(page, /^Script/);

  // Gate 0: generate the script (async job processed by the worker).
  await page.getByRole('button', { name: 'Generate script' }).click();
  const v1 = page.getByRole('article', { name: 'Script version 1' });
  await expect(v1).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await expect(v1).toContainText('Pending review');
  await expect(page.getByLabel('Content status')).toHaveText('Script review');

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
  await expect(page.getByLabel('Content status')).toHaveText('Script review');

  // Storyboard from the approved script.
  await openTab(page, /^Storyboard/);
  await page.getByRole('button', { name: 'Generate storyboard' }).click();
  const s1 = page.getByRole('article', { name: 'Storyboard version 1' });
  await expect(s1).toBeVisible({ timeout: GENERATION_TIMEOUT });
  await expect(s1.getByRole('list', { name: 'Scenes' }).getByRole('listitem')).not.toHaveCount(0);
  await expect(page.getByLabel('Content status')).toHaveText('Storyboard review');

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
  await expect(page.getByLabel('Content status')).toHaveText('Storyboard review');

  // A reload shows the persisted state (the tab is kept in the URL hash).
  await page.reload();
  await openTab(page, /^Storyboard/);
  await expect(page.getByRole('article', { name: 'Storyboard version 2' })).toContainText('In use');
});

test('editor: scene images → review → keyframes (gate 3)', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemoContent(page, EDITOR, passwordOf('EDITOR'));
  // With an approved storyboard the workspace opens on the keyframes tab.
  await expect(page.getByRole('tab', { name: /^Keyframes/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = page.getByLabel('Scene image controls');
  await expect(panel).toBeVisible();

  // The price is on the button (R-D4): the seeded mock image model is free ($0, never "?"), so
  // it is within the cost threshold and generates in one click.
  const generate = panel.getByRole('button', { name: /^Generate images · ~\$0$/ });
  await expect(generate).toBeVisible();
  await expect(panel.getByLabel('Image estimate')).toContainText('mock/solid-image');

  // One job per scene; the worker generates, validates and stores the images.
  await generate.click();
  await expect(page.getByLabel('Content status')).toHaveText('Asset review', {
    timeout: GENERATION_TIMEOUT,
  });
  await page.reload();
  // Pages stream behind a loading state: wait for the panel before counting its scenes.
  await expect(page.getByLabel('Scene image controls')).toBeVisible();
  const scenes = page.getByRole('article', { name: /^Scene \d+ images$/ });
  const sceneCount = await scenes.count();
  expect(sceneCount).toBeGreaterThan(0);

  for (let n = 1; n <= sceneCount; n++) {
    const scene = page.getByRole('article', { name: `Scene ${String(n)} images` });
    const candidate = scene.getByRole('listitem', { name: `Scene ${String(n)} candidate 1` });
    // The image is streamed through the API from object storage and decodes in the browser.
    const img = candidate.getByRole('img', { name: `Scene ${String(n)} candidate 1` });
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await candidate.getByRole('button', { name: 'Approve' }).click();
    await expect(candidate).toContainText('Approved');
    await candidate.getByRole('button', { name: 'Use as keyframe' }).click();
    await expect(scene).toContainText('Keyframe chosen');
  }
  await expect(page.getByLabel('Keyframe gate')).toHaveText('All scenes have a keyframe');
  await expect(page.getByRole('tab', { name: /^Keyframes/ })).toContainText(
    `${String(sceneCount)}/${String(sceneCount)}`,
  );
});

test('editor: voice profile → clips → voice-over (gate 4)', async ({ page }) => {
  test.setTimeout(180_000);
  await openDemoContent(page, EDITOR, passwordOf('EDITOR'));

  // A project voice profile (Settings → Voice profiles) with the seeded mock TTS model.
  await page.goto('/settings/voices');
  const form = page.getByRole('form', { name: 'New voice profile' });
  await form.getByLabel('Name').fill('Narrator');
  await form
    .getByLabel('Model')
    .selectOption({ label: 'Mock speech (FFmpeg tone) (mock/tone-tts)' });
  await form.getByLabel(/^Voice/).fill('mock-a');
  await form.getByRole('button', { name: 'Create voice profile' }).click();
  await expect(page.getByRole('list', { name: 'Voice profiles' })).toContainText('Narrator');

  await page.goBack();
  await page.reload();
  // Every scene has a keyframe: the workspace opens on the clips tab.
  await expect(page.getByRole('tab', { name: /^Clips/ })).toHaveAttribute('aria-selected', 'true');
  const clips = page.getByLabel('Scene clip controls');
  await expect(clips).toBeVisible();

  // The editor may pick any enabled video model; the default is the task route.
  const modelSelect = clips.getByLabel('Model');
  await expect(modelSelect).toHaveValue('');
  await expect(modelSelect).toContainText('Mock video clips');
  // The estimate (billed seconds, retention) is behind the price on the button (R-D4).
  const generateClips = clips.getByRole('button', { name: /^Generate clips · ~\$0$/ });
  await expect(generateClips).toBeVisible();
  const estimate = clips.getByLabel('Clip estimate');
  await expect(estimate).toContainText('mock/still-video');
  await expect(estimate).toContainText('billed as');
  await expect(estimate).toContainText('keeps prompts and keyframes');
  const clipScenes = page.getByRole('article', { name: /^Scene \d+ clips$/ });
  const sceneCount = await clipScenes.count();
  expect(sceneCount).toBeGreaterThan(0);
  await generateClips.click();
  await expect(page.getByText(/clip job\(s\) queued/)).toBeVisible();
  // The worker submits, polls the mock provider, renders and validates real MP4s (FFmpeg).
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.getByLabel('Scene clip controls')).toBeVisible();
        return page.getByRole('listitem', { name: /^Scene \d+ clip 1$/ }).count();
      },
      { timeout: GENERATION_TIMEOUT, intervals: [1_000] },
    )
    .toBe(sceneCount);
  for (let n = 1; n <= sceneCount; n++) {
    const scene = page.getByRole('article', { name: `Scene ${String(n)} clips` });
    const candidate = scene.getByRole('listitem', { name: `Scene ${String(n)} clip 1` });
    // The clip streams through the API with Range support (seeking). Playwright's Chromium has
    // no H.264 decoder, so the stream is checked over HTTP instead of decoding it.
    const src = await candidate.locator('video').getAttribute('src');
    expect(src).toBeTruthy();
    const ranged = await page.request.get(src ?? '', { headers: { range: 'bytes=0-15' } });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()['content-type']).toBe('video/mp4');
    expect((await ranged.body()).subarray(4, 8).toString('latin1')).toBe('ftyp');
    await candidate.getByRole('button', { name: 'Approve' }).click();
    await expect(candidate).toContainText('Approved');
    await candidate.getByRole('button', { name: 'Use as clip' }).click();
    await expect(scene).toContainText('Clip chosen');
  }
  await expect(page.getByLabel('Clip gate')).toHaveText('All scenes have a clip');

  // Voice-over with the new profile; narration is synthesized by the mock TTS (FFmpeg tone).
  await openTab(page, /^Voice-over/);
  const voice = page.getByLabel('Voice-over controls');
  await voice.getByLabel('Voice profile').selectOption({ label: 'Narrator · mock-a · vi' });
  const generateVoice = voice.getByRole('button', { name: /^Generate voice-overs · ~\$0$/ });
  await expect(generateVoice).toBeEnabled();
  await expect(voice.getByLabel('Voice-over estimate')).toContainText('mock/tone-tts');
  await generateVoice.click();
  await expect(page.getByText(/voice-over job\(s\) queued/)).toBeVisible();
  const voiceScenes = page.getByRole('list', { name: /^Scene \d+ voice-over candidates$/ });
  // Every fixture scene has voice-over text: one generated candidate each.
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.getByLabel('Voice-over controls')).toBeVisible();
        return voiceScenes.count();
      },
      { timeout: GENERATION_TIMEOUT, intervals: [1_000] },
    )
    .toBe(sceneCount);
  const withAudio = await voiceScenes.count();
  for (let i = 0; i < withAudio; i++) {
    const candidate = voiceScenes.nth(i).getByRole('listitem').first();
    const audio = candidate.locator('audio');
    await expect
      .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).duration), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await candidate.getByRole('button', { name: 'Approve' }).click();
    await candidate.getByRole('button', { name: 'Use as voice-over' }).click();
    await expect(candidate).toHaveClass(/selected/);
    await expect(candidate).toContainText('Voice-over');
  }
  await expect(page.getByLabel('Voice-over gate')).toHaveText(
    'Every scene with text has a voice-over',
  );
});

test('editor: render → QC → approve (gate 5) → export the package', async ({ page }) => {
  test.setTimeout(240_000);
  await openDemoContent(page, EDITOR, passwordOf('EDITOR'));
  // Every scene has a clip and a voice-over: the workspace opens on the render tab.
  await expect(page.getByRole('tab', { name: /^Render/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = page.getByLabel('Render controls');
  await expect(panel.getByLabel('Render readiness')).toContainText('Ready:');
  await expect(panel).toContainText('upscaled from'); // mock clips are below 1080×1920
  await panel.getByRole('button', { name: 'Render video' }).click();
  await expect(page.getByText('Render queued.')).toBeVisible();

  // The worker renders with FFmpeg (mixed scenes, narration, captions, loudness) and runs QC.
  const card = page.getByRole('article', { name: 'Render 1' });
  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(page.getByLabel('Render controls')).toBeVisible();
        return (await card.count()) > 0 ? card.innerText() : '';
      },
      { timeout: 180_000, intervals: [2_000] },
    )
    .toContain('Review required');
  await expect(card).toContainText('Passed');
  await expect(card).toContainText('1080×1920');
  await expect(card.getByLabel('Cost summary')).toContainText('rendering $0');

  // The video streams through the API with Range support (Chromium here has no H.264 decoder).
  const src = await card.locator('video').getAttribute('src');
  const head = await page.request.get(src ?? '', { headers: { range: 'bytes=0-15' } });
  expect(head.status()).toBe(206);
  expect(head.headers()['content-type']).toBe('video/mp4');

  await card.getByRole('button', { name: 'Approve render' }).click();
  await expect(card).toContainText('Current export');
  await expect(page.getByLabel('Content status')).toHaveText('Approved');
  await card.getByRole('button', { name: 'Export package' }).click();
  await expect(page.getByLabel('Content status')).toHaveText('Exported');

  const downloads = card.getByRole('list', { name: 'Package downloads' });
  for (const name of [
    'video.mp4',
    'captions.srt',
    'thumbnail.jpg',
    'manifest.json',
    'cost-report.json',
  ]) {
    await expect(downloads.getByRole('link', { name })).toBeVisible();
  }
  const srt = await page.request.get(
    (await downloads.getByRole('link', { name: 'captions.srt' }).getAttribute('href')) ?? '',
  );
  expect(await srt.text()).toMatch(/^1\n00:00:00,000 --> /);
  const manifest = (await (
    await page.request.get(
      (await downloads.getByRole('link', { name: 'manifest.json' }).getAttribute('href')) ?? '',
    )
  ).json()) as { outputs: { role: string }[]; review: { status: string } };
  expect(manifest.outputs.map((o) => o.role)).toEqual(['video', 'subtitles', 'thumbnail']);
  expect(manifest.review.status).toBe('approved');
});

test('viewer: sees the versions but no generate, edit or review controls', async ({ page }) => {
  await openDemoContent(page, VIEWER, passwordOf('VIEWER'));
  const noControls = async () => {
    await expect(page.getByRole('button', { name: /Generate/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Edit|Approve|Reject|keyframe|Regenerate|Resync/ }),
    ).toHaveCount(0);
  };
  await openTab(page, /^Script/);
  await expect(page.getByRole('article', { name: 'Script version 2' })).toBeVisible();
  await noControls();
  await openTab(page, /^Storyboard/);
  await expect(page.getByRole('article', { name: 'Storyboard version 2' })).toBeVisible();
  await noControls();
  await openTab(page, /^Keyframes/);
  await expect(page.getByLabel('Keyframe gate')).toHaveText('All scenes have a keyframe');
  await noControls();
  await openTab(page, /^Clips/);
  await expect(page.getByLabel('Clip gate')).toHaveText('All scenes have a clip');
  await noControls();
  await openTab(page, /^Voice-over/);
  await expect(page.getByLabel('Voice-over gate')).toHaveText(
    'Every scene with text has a voice-over',
  );
  await noControls();
  await openTab(page, /^Render/);
  await expect(page.getByRole('article', { name: 'Render 1' })).toContainText('Current export');
  await expect(page.getByRole('button', { name: /Render video|Export package/ })).toHaveCount(0);
  await noControls();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('list', { name: 'Version history' })).toContainText(
    'Script v2 approved',
  );
});
