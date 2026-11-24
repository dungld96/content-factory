import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Fragment } from 'react';

import type {
  AiModelDto,
  BudgetDto,
  AiProviderList,
  CostReportDto,
  RenderListDto,
  RenderPlanDto,
  ContentItemDto,
  ContentMasterDto,
  GenerationJobDto,
  JobCostDto,
  Page,
  ProjectDto,
  ScriptVersionDto,
  StoryboardImagesDto,
  StoryboardVideosDto,
  StoryboardVoiceoversDto,
  VoiceProfileListDto,
  StoryboardVersionDetailDto,
  StoryboardVersionDto,
} from '@acf/contracts';

import { Icon, type IconName } from '@/components/icon';
import { ProductPhotos } from '@/components/product-photos';
import { PageCrumbs } from '@/components/shell/page-crumbs';
import { RelativeTime } from '@/components/local-time';
import { FocusReview } from '@/components/review/focus-review';
import { ReviewPanel } from '@/components/review/review-panel';
import { TextDiff } from '@/components/review/text-diff';
import { Pill, VersionPill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { assetContentUrl } from '@/lib/asset-url';
import { jobErrorText, platformLabel, wordCount } from '@/lib/format';
import type { Locale, Translate } from '@/lib/i18n';
import { getLocale, getT } from '@/lib/i18n/server';
import { usableModels } from '@/lib/model-options';
import { addUsd, formatUsd, sumJobCosts } from '@/lib/money';
import { statusInfo } from '@/lib/content-status';
import { loadOpsSummary } from '@/lib/ops-summary';
import { buildTodo } from '@/lib/todo';
import { loadWorkspace } from '@/lib/workspace';
import { buildSceneRows, nextStep } from '@/lib/scene-board';

import { AudioPlan } from './audio-plan';
import { HistoryDrawer } from './history-drawer';
import { JobActivity } from './job-activity';
import { KeyframeReview, type SceneBrief } from './keyframe-review';
import { LiveRefresh } from './live-refresh';
import { NextStepBar } from './next-step-bar';
import {
  BriefCheck,
  GenerateButton,
  ReviewButtons,
  SceneEditor,
  SceneReferencesButton,
  ScriptEditor,
} from './pipeline-controls';
import { RenderPanel } from './render-panel';
import { ResyncBriefButton } from './scene-images';
import { ScenesTab } from './scenes-tab';
import { StageRail, type StageState, type WorkspaceStage } from './stage-rail';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('ws.pageTitle') };
}

type TabId = 'script' | 'storyboard' | 'scenes' | 'render';

const TONE_BADGE: Readonly<Record<string, string>> = {
  purple: 'info',
  amber: 'review',
  green: 'success',
  red: 'danger',
  gray: 'neutral',
};
const TONE_ICON: Readonly<Record<string, IconName>> = {
  purple: 'resume',
  amber: 'eye',
  green: 'check',
  red: 'warning',
  gray: 'history',
};

interface ActivityEvent {
  readonly at: string;
  readonly title: string;
  readonly detail: string;
}

interface SceneJobs {
  readonly sceneNumber: number;
  readonly activeJob: GenerationJobDto | null;
  readonly lastJob: GenerationJobDto | null;
}

function activityOf(
  t: Translate,
  locale: Locale,
  scripts: readonly ScriptVersionDto[],
  storyboards: readonly StoryboardVersionDto[],
  media: readonly { kind: 'image' | 'clip' | 'voice'; scenes: readonly SceneJobs[] }[],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const source = (s: 'generated' | 'edited') =>
    t(s === 'generated' ? 'ws.ev.generated' : 'ws.ev.edited');
  const review = (
    key: 'ws.ev.script' | 'ws.ev.storyboard',
    v: ScriptVersionDto | StoryboardVersionDto,
  ) => {
    if (v.reviewedAt && v.status !== 'pending_review') {
      events.push({
        at: v.reviewedAt,
        title: t(key, {
          version: v.version,
          action: t(v.status === 'approved' ? 'ws.ev.approved' : 'ws.ev.rejected'),
        }),
        detail: v.reviewNote
          ? t('ws.ev.reviewNote', { note: v.reviewNote })
          : t('ws.ev.reviewRecorded'),
      });
    }
  };
  for (const s of scripts) {
    events.push({
      at: s.createdAt,
      title: t('ws.ev.script', { version: s.version, action: source(s.source) }),
      detail: s.basedOnVersionId ? t('ws.ev.basedOnEarlier') : s.content.title,
    });
    review('ws.ev.script', s);
  }
  for (const b of storyboards) {
    events.push({
      at: b.createdAt,
      title: t('ws.ev.storyboard', { version: b.version, action: source(b.source) }),
      detail: `${String(b.totalDurationSeconds)}s${b.stale ? ` ${t('ws.ev.olderScript')}` : ''}`,
    });
    review('ws.ev.storyboard', b);
  }
  for (const { kind, scenes } of media) {
    for (const scene of scenes) {
      const job = scene.activeJob ?? scene.lastJob;
      if (job) {
        events.push({
          at: job.completedAt ?? job.startedAt ?? job.queuedAt,
          title: t('ws.ev.sceneJob', {
            number: scene.sceneNumber,
            kind: t(`ws.ev.kind.${kind}`),
            status: t(`state.${job.status}`),
          }),
          detail: `${job.modelKey}${job.errorCode ? ` · ${jobErrorText(job.errorCode, locale)}` : ''}`,
        });
      }
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

const jobsOf = (scenes: readonly SceneJobs[] | undefined): GenerationJobDto[] =>
  (scenes ?? []).flatMap((s) => {
    const job = s.activeJob ?? s.lastJob;
    return job ? [job] : [];
  });

const VERSION_TEXT = {
  pending_review: 'version.pending_review',
  approved: 'version.approved',
  rejected: 'version.rejected',
} as const;

export default async function ContentPage({
  params,
}: {
  readonly params: Promise<{ contentId: string }>;
}) {
  const { contentId } = await params;
  const [item, t, locale] = await Promise.all([
    apiGet<ContentItemDto>(`/content/${contentId}`),
    getT(),
    getLocale(),
  ]);
  if (item.kind === 'unauthenticated') redirect('/login');
  if (item.kind === 'error') {
    if (item.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        {t('ws.loadError')}
      </section>
    );
  }
  const content = item.data;
  const approvedBoard = content.approvedStoryboardVersionId;
  const [
    project,
    scripts,
    storyboards,
    master,
    images,
    videos,
    voiceovers,
    profiles,
    imageModels,
    videoModels,
    renderPlan,
    renderList,
    textModels,
    providers,
    budget,
  ] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${content.projectId}`),
    apiGet<Page<ScriptVersionDto>>(`/content/${contentId}/scripts?limit=20`),
    apiGet<Page<StoryboardVersionDto>>(`/content/${contentId}/storyboards?limit=20`),
    apiGet<ContentMasterDto>(`/content-masters/${content.contentMasterId}`),
    approvedBoard
      ? apiGet<StoryboardImagesDto>(`/storyboards/${approvedBoard}/images`)
      : Promise.resolve(null),
    approvedBoard
      ? apiGet<StoryboardVideosDto>(`/storyboards/${approvedBoard}/videos`)
      : Promise.resolve(null),
    approvedBoard
      ? apiGet<StoryboardVoiceoversDto>(`/storyboards/${approvedBoard}/voiceovers`)
      : Promise.resolve(null),
    apiGet<VoiceProfileListDto>(`/projects/${content.projectId}/voice-profiles`),
    apiGet<Page<AiModelDto>>('/ai/models?capability=image_generation&status=enabled&limit=100'),
    apiGet<Page<AiModelDto>>('/ai/models?capability=video_generation&status=enabled&limit=100'),
    apiGet<RenderPlanDto>(`/content/${contentId}/render-plan`),
    apiGet<RenderListDto>(`/content/${contentId}/renders`),
    apiGet<Page<AiModelDto>>('/ai/models?capability=llm&status=enabled&limit=100'),
    apiGet<AiProviderList>('/ai/providers'),
    apiGet<BudgetDto>(`/projects/${content.projectId}/budget`),
  ]);
  const plan = renderPlan.kind === 'ok' ? renderPlan.data : null;
  const renders = renderList.kind === 'ok' ? renderList.data.items : [];
  const latestRender = renders[0];
  const costReport =
    latestRender?.status === 'succeeded'
      ? await apiGet<CostReportDto>(`/renders/${latestRender.id}/cost-report`)
      : null;
  const approvedRender = renders.find((r) => r.isApproved);
  const providerList = providers.kind === 'ok' ? providers.data.data : [];
  // R-D4: the effective cost-confirmation threshold of this project ($1 when unknown).
  const threshold = budget.kind === 'ok' ? budget.data.effectiveConfirmThresholdUsd : '1';
  const optionsOf = (list: typeof imageModels) =>
    list.kind === 'ok'
      ? usableModels(list.data.data, providerList).map((m) => ({
          modelKey: m.modelKey,
          label: m.displayName,
        }))
      : [];
  const canEdit =
    project.kind === 'ok' && project.data.role !== 'viewer' && content.archivedAt === null;
  const scriptList = scripts.kind === 'ok' ? scripts.data.data : [];
  const storyboardList = storyboards.kind === 'ok' ? storyboards.data.data : [];
  const latestScript = scriptList[0];
  const previousScript = scriptList[1];
  const approvedScript = scriptList.find((s) => s.isApproved);
  const latestStoryboardId = storyboardList[0]?.id;
  const scriptJobId = scriptList.find((s) => s.generationJobId)?.generationJobId;
  const storyboardJobId = storyboardList.find((s) => s.generationJobId)?.generationJobId;
  const [storyboard, scriptJob, storyboardJob] = await Promise.all([
    latestStoryboardId
      ? apiGet<StoryboardVersionDetailDto>(`/storyboards/${latestStoryboardId}`)
      : Promise.resolve(null),
    scriptJobId ? apiGet<GenerationJobDto>(`/generation-jobs/${scriptJobId}`) : null,
    storyboardJobId ? apiGet<GenerationJobDto>(`/generation-jobs/${storyboardJobId}`) : null,
  ]);
  const imageData = images?.kind === 'ok' ? images.data : null;
  const board = storyboard?.kind === 'ok' ? storyboard.data : null;
  const scriptJobData = scriptJob?.kind === 'ok' ? scriptJob.data : null;
  const storyboardJobData = storyboardJob?.kind === 'ok' ? storyboardJob.data : null;
  const imageJobs = jobsOf(imageData?.scenes);
  const videoData = videos?.kind === 'ok' ? videos.data : null;
  const voiceData = voiceovers?.kind === 'ok' ? voiceovers.data : null;
  const profileList = profiles.kind === 'ok' ? profiles.data.items : [];
  const clipJobs = jobsOf(videoData?.scenes);
  const voiceJobs = jobsOf(voiceData?.scenes);
  const clipCount = videoData?.scenes.filter((s) => s.clip !== null).length ?? 0;
  const voiceScenes = voiceData?.scenes.filter((s) => s.text !== '') ?? [];
  const voiceCount = voiceScenes.filter((s) => s.voiceover !== null).length;
  const projectName = project.kind === 'ok' ? project.data.name : t('table.project');
  const masterTitle = master.kind === 'ok' ? master.data.title : t('ws.theMaster');
  const keyframeCount = imageData?.scenes.filter((s) => s.keyframe !== null).length ?? 0;
  const sceneCount = imageData?.scenes.length ?? board?.scenes.length ?? 0;
  const keyframesDone = imageData?.keyframesComplete ?? false;
  const latestScriptJob = latestScript?.generationJobId === scriptJobId ? scriptJobData : null;

  // P4d: with voice-over off, the voice-over stage is complete by definition.
  const voiceDone = !content.voiceEnabled || (voiceData?.voiceoversComplete ?? false);
  const mediaDone = (videoData?.clipsComplete ?? false) && voiceDone;
  const sceneRows = buildSceneRows(imageData, videoData, voiceData, content.voiceEnabled, t);
  const doneScenes = sceneRows.filter((r) => r.status === 'done').length;
  const initialTab: TabId = !approvedScript
    ? 'script'
    : !content.approvedStoryboardVersionId
      ? 'storyboard'
      : !keyframesDone || !mediaDone
        ? 'scenes'
        : 'render';
  const initialStage = !keyframesDone ? 'keyframes' : 'clips';
  const keyframeByScene = new Map(
    board && imageData && board.id === imageData.storyboardVersionId
      ? imageData.scenes.flatMap((s) => (s.keyframe ? [[s.sceneId, s.keyframe] as const] : []))
      : [],
  );
  const sourceText = (s: 'generated' | 'edited') =>
    t(s === 'generated' ? 'ws.script.generated' : 'ws.script.edited');

  // --- Review checklists (R-D3): items with an automatic check that passed start ticked.
  const targetWords = Math.round(content.targetDurationSeconds * 2.6);
  const scriptChecks = latestScript
    ? (() => {
        const words = wordCount(latestScript.content.voiceOver);
        const claims = latestScript.content.claimsRequiringVerification;
        return [
          {
            id: 'length',
            label: t('check.script.length', { words, seconds: content.targetDurationSeconds }),
            auto: Math.abs(words - targetWords) <= Math.max(8, targetWords * 0.25),
          },
          { id: 'hook', label: t('check.script.hook') },
          { id: 'brief', label: t('check.script.brief') },
          ...(claims.length === 0
            ? [{ id: 'claims', label: t('check.script.noClaims'), auto: true }]
            : claims.map((c, n) => ({
                id: `claim-${String(n)}`,
                label: t('check.script.claim', { claim: c.claim }),
              }))),
          {
            id: 'cta',
            label: t('check.script.cta'),
            auto: latestScript.content.callToAction !== '',
          },
        ];
      })()
    : [];
  const boardChecks = board
    ? [
        {
          id: 'duration',
          label: t('check.board.duration', {
            total: board.totalDurationSeconds,
            target: content.targetDurationSeconds,
          }),
          auto: Math.abs(board.totalDurationSeconds - content.targetDurationSeconds) <= 2,
        },
        { id: 'flow', label: t('check.board.flow') },
        { id: 'prompts', label: t('check.board.prompts') },
        { id: 'brand', label: t('check.board.brand') },
      ]
    : [];

  // Position of this item among the To-do decisions (focus review header, oldest first).
  const [workspaceForQueue, opsForQueue] = await Promise.all([loadWorkspace(), loadOpsSummary()]);
  const decisions =
    workspaceForQueue.kind === 'ok'
      ? buildTodo(
          workspaceForQueue.data.content,
          opsForQueue.kind === 'ok' ? opsForQueue.data : null,
        )
          .items.filter((i) => i.kind === 'gate')
          .sort((a, b) => a.at.localeCompare(b.at))
      : [];
  const here = decisions.findIndex((i) => i.href.startsWith(`/content/${content.id}#`));
  const queue =
    here >= 0
      ? {
          index: here + 1,
          total: decisions.length,
          prev: decisions[here - 1]?.href ?? null,
          next: decisions[here + 1]?.href ?? null,
        }
      : undefined;
  const previousScriptMain = previousScript ? (
    <>
      <div className="script-block">
        <div className="script-block-head">
          <h3>{t('ws.hook')}</h3>
        </div>
        <p>“{previousScript.content.hook}”</p>
      </div>
      <div className="script-block">
        <div className="script-block-head">
          <h3>{t('ws.voiceScript')}</h3>
        </div>
        <p>“{previousScript.content.voiceOver}”</p>
      </div>
      <div className="script-block">
        <div className="script-block-head">
          <h3>{t('ws.cta')}</h3>
        </div>
        <p>“{previousScript.content.callToAction}”</p>
      </div>
    </>
  ) : null;
  const previousBoard = storyboardList[1];
  const focusSubtitle = [
    content.title,
    projectName,
    platformLabel(t, content.targetPlatform),
    t('ws.brief.seconds', { count: content.targetDurationSeconds }),
  ].join(' · ');
  const briefCard = (
    <section className="card focus-brief" aria-label={t('ws.brief')}>
      <div className="card-head">
        <h3>{t('ws.brief')}</h3>
        <span className="spacer" />
        <a className="t-13" href="#brief">
          {t('common.open')}
        </a>
      </div>
      <div className="card-body col">
        <p className="t-13">{content.brief.topic}</p>
        <div className="row wrap">
          {[content.brief.audience, content.brief.tone, content.brief.objective]
            .filter((v): v is string => Boolean(v))
            .map((v) => (
              <span key={v} className="chip">
                {v}
              </span>
            ))}
          {(content.brief.productAssetIds?.length ?? 0) > 0 && (
            <span className="chip">
              {t('ws.head.photos', { count: content.brief.productAssetIds?.length ?? 0 })}
            </span>
          )}
        </div>
      </div>
    </section>
  );

  const briefPanel = (
    <section className="card work-card" aria-label={t('ws.brief')}>
      <div className="brief-box">
        <span className="box-label">{t('ws.brief')}</span>
        <p>{content.brief.topic}</p>
        <div className="tags">
          {content.brief.audience && (
            <span className="tag">{t('ws.brief.audience', { value: content.brief.audience })}</span>
          )}
          {content.brief.tone && (
            <span className="tag">{t('ws.brief.tone', { value: content.brief.tone })}</span>
          )}
          {content.brief.objective && (
            <span className="tag">
              {t('ws.brief.objective', { value: content.brief.objective })}
            </span>
          )}
          <span className="tag">
            {t('ws.brief.seconds', { count: content.targetDurationSeconds })}
          </span>
          <span className="tag">{content.aspectRatio}</span>
          <span className="tag">{content.language.toUpperCase()}</span>
        </div>
        <p className="brief-meta" aria-label={t('ws.masterLabel')}>
          {t('ws.variantOf')}{' '}
          <Link href={`/masters/${content.contentMasterId}`}>{masterTitle}</Link>
          {content.targetPlatform
            ? ` ${t('ws.forPlatform', { platform: platformLabel(t, content.targetPlatform) })}`
            : ''}{' '}
          {content.masterBriefStale && <Pill tone="amber">{t('ws.masterChanged')}</Pill>}
        </p>
        {canEdit && content.masterBriefStale && (
          <div className="review-actions">
            <ResyncBriefButton contentId={content.id} />
          </div>
        )}
        <ProductPhotos
          projectId={content.projectId}
          brief={content.brief}
          endpoint={`/content/${content.id}`}
          canEdit={canEdit}
          savedText={t('ws.photosSaved')}
        />
        <BriefCheck contentId={content.id} />
        <AudioPlan contentId={content.id} voiceEnabled={content.voiceEnabled} canEdit={canEdit} />
      </div>
    </section>
  );

  const scriptPanel = (
    <article
      className="card work-card"
      aria-label={
        latestScript ? t('ws.script.label', { version: latestScript.version }) : t('ws.script.none')
      }
    >
      {content.status === 'scripting' && (
        <p className="notice" role="status">
          {t('ws.generatingScript')}
        </p>
      )}

      <FocusReview
        gate={t('review.gateOf', { number: 1 })}
        title={t('review.focus.script')}
        subtitle={focusSubtitle}
        reviewable={canEdit && latestScript?.status === 'pending_review'}
        queue={queue}
        previous={
          previousScript && latestScript
            ? {
                label: `v${String(previousScript.version)}`,
                current: `v${String(latestScript.version)}`,
                main: previousScriptMain,
              }
            : undefined
        }
        main={
          <>
            <div className="section-head">
              <div>
                <h2>
                  {latestScript
                    ? t('ws.script.title', { title: latestScript.content.title })
                    : t('ws.script.none')}
                </h2>
                <p>
                  {latestScript ? (
                    <>
                      {t('ws.script.meta', {
                        version: latestScript.version,
                        source: sourceText(latestScript.source),
                      })}
                      {latestScriptJob
                        ? ` ${t('ws.script.by', { model: latestScriptJob.modelKey })}`
                        : ''}{' '}
                      · <RelativeTime iso={latestScript.createdAt} />
                    </>
                  ) : (
                    t('ws.script.empty')
                  )}
                </p>
              </div>
              {latestScript && (
                <span className="actions">
                  <VersionPill status={latestScript.status} />
                  {latestScript.isApproved && <Pill tone="green">{t('ws.inUse')}</Pill>}
                </span>
              )}
            </div>
            {latestScript ? (
              <>
                <div className="script-block">
                  <div className="script-block-head">
                    <h3>{t('ws.direction')}</h3>
                  </div>
                  <p>
                    <span className="script-label">{t('ws.angle')}</span>
                    {latestScript.content.plan.angle}
                  </p>
                  <p>
                    <span className="script-label">{t('ws.hook')}</span>“{latestScript.content.hook}
                    ”
                  </p>
                </div>
                <div className="script-block">
                  <div className="script-block-head">
                    <h3>{t('ws.voiceScript')}</h3>
                  </div>
                  <p>“{latestScript.content.voiceOver}”</p>
                  <p className="muted small-text">
                    {t('ws.words', {
                      count: wordCount(latestScript.content.voiceOver),
                      seconds: content.targetDurationSeconds,
                    })}
                  </p>
                  {previousScript && (
                    <TextDiff
                      before={previousScript.content.voiceOver}
                      after={latestScript.content.voiceOver}
                      version={previousScript.version}
                    />
                  )}
                </div>
                <div className="script-block">
                  <div className="script-block-head">
                    <h3>{t('ws.cta')}</h3>
                  </div>
                  <p>“{latestScript.content.callToAction}”</p>
                </div>
                {latestScript.content.claimsRequiringVerification.length > 0 && (
                  <div className="script-block">
                    <div className="script-block-head">
                      <h3>{t('ws.claims')}</h3>
                    </div>
                    <ul>
                      {latestScript.content.claimsRequiringVerification.map((c) => (
                        <li key={c.claim}>
                          {c.claim} <span className="muted">({c.reason})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {latestScript.reviewNote && (
                  <p className="muted small-text">
                    {t('ws.reviewNote', { note: latestScript.reviewNote })}
                  </p>
                )}
              </>
            ) : (
              <div className="empty">{t('ws.noScript')}</div>
            )}
          </>
        }
        side={
          <>
            {canEdit && latestScript?.status === 'pending_review' && (
              <ReviewPanel
                kind="scripts"
                id={latestScript.id}
                what={t('review.what.script')}
                gate={t('review.gate', { number: 1, name: t('ws.check.scriptApproval') })}
                items={scriptChecks}
              />
            )}
            {briefCard}
          </>
        }
      />
      {canEdit && (
        <div className="review-actions">
          {latestScript && <ScriptEditor script={latestScript} />}
          <GenerateButton
            path={`/content/${content.id}/scripts/generate`}
            label={latestScript ? t('ws.regenerateScript') : t('ws.generateScript')}
            again={latestScript !== undefined}
            primary={!latestScript}
            models={optionsOf(textModels)}
          />
        </div>
      )}

      {scriptList.length > 1 && (
        <details className="earlier-versions">
          <summary>{t('ws.earlier', { count: scriptList.length - 1 })}</summary>
          <ul className="plain-list" aria-label={t('ws.earlierScripts')}>
            {scriptList.slice(1).map((v) => (
              <li key={v.id} aria-label={t('ws.script.label', { version: v.version })}>
                <p className="small-text">
                  <b>{t('ws.version', { version: v.version })}</b> · {sourceText(v.source)} ·{' '}
                  {v.isApproved ? t('ws.approvedInUse') : t(VERSION_TEXT[v.status])} ·{' '}
                  {t('ws.wordsShort', { count: wordCount(v.content.voiceOver) })}
                </p>
                <p className="small-text">
                  <b>{t('ws.hookLine')}</b> “{v.content.hook}”
                </p>
                <p className="small-text muted">“{v.content.voiceOver}”</p>
                {canEdit && v.status === 'pending_review' && (
                  <div className="review-actions">
                    <ReviewButtons
                      kind="scripts"
                      id={v.id}
                      label={t('ws.scriptV', { version: v.version })}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );

  const earlierStoryboards =
    storyboardList.length > 1 ? (
      <details className="earlier-versions">
        <summary>{t('ws.earlierBoards', { count: storyboardList.length - 1 })}</summary>
        <ul className="plain-list" aria-label={t('ws.earlierBoardsLabel')}>
          {storyboardList.slice(1).map((v) => (
            <li key={v.id} aria-label={t('ws.board.label', { version: v.version })}>
              <p className="small-text">
                <b>{t('ws.version', { version: v.version })}</b> · {sourceText(v.source)} ·{' '}
                {v.totalDurationSeconds} s ·{' '}
                {v.isApproved
                  ? t('ws.approvedInUse')
                  : v.stale
                    ? t('ws.stale')
                    : t(VERSION_TEXT[v.status])}
              </p>
              {canEdit && v.status === 'pending_review' && !v.stale && (
                <div className="review-actions">
                  <ReviewButtons
                    kind="storyboards"
                    id={v.id}
                    label={t('ws.storyboardV', { version: v.version })}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
    ) : null;

  const generateStoryboard =
    canEdit && approvedScript ? (
      <GenerateButton
        path={`/scripts/${approvedScript.id}/storyboards/generate`}
        label={storyboardList.length > 0 ? t('ws.regenerateBoard') : t('ws.generateBoard')}
        again={storyboardList.length > 0}
        primary={storyboardList.length === 0}
        models={optionsOf(textModels)}
      />
    ) : null;

  // Start second of each scene (cumulative durations).
  const sceneStarts: number[] = [];
  let elapsed = 0;
  for (const scene of board?.scenes ?? []) {
    sceneStarts.push(elapsed);
    elapsed += scene.durationSeconds;
  }
  const storyboardPanel = board ? (
    <article
      className="card work-card"
      aria-label={t('ws.board.label', { version: board.version })}
    >
      <div className="section-head">
        <div>
          <h2>{t('ws.board.title', { version: board.version })}</h2>
          <p>
            {t('ws.board.meta', {
              scenes: board.scenes.length,
              seconds: board.totalDurationSeconds,
              source: sourceText(board.source),
            })}{' '}
            <RelativeTime iso={board.createdAt} />
          </p>
        </div>
        <span className="actions">
          <VersionPill status={board.status} />
          {board.stale && <Pill tone="amber">{t('ws.stale')}</Pill>}
          {board.isApproved && <Pill tone="green">{t('ws.inUse')}</Pill>}
        </span>
      </div>
      {content.status === 'storyboarding' && (
        <p className="notice" role="status">
          {t('ws.board.generating')}
        </p>
      )}
      <FocusReview
        gate={t('review.gateOf', { number: 2 })}
        title={t('review.focus.storyboard')}
        subtitle={focusSubtitle}
        reviewable={canEdit && board.status === 'pending_review' && !board.stale}
        queue={queue}
        previous={
          previousBoard
            ? {
                label: `v${String(previousBoard.version)}`,
                current: `v${String(board.version)}`,
                main: (
                  <p className="t-13">
                    {t('review.boardPrevious', {
                      seconds: previousBoard.totalDurationSeconds,
                      source: sourceText(previousBoard.source),
                    })}
                  </p>
                ),
              }
            : undefined
        }
        main={
          <ul className="storyboard-grid" aria-label={t('ws.board.scenes')}>
            {board.scenes.map((scene, i) => {
              const start = sceneStarts[i] ?? 0;
              const end = start + scene.durationSeconds;
              const keyframe = keyframeByScene.get(scene.id);
              return (
                <li key={scene.id} className="scene-card">
                  <div className="scene-art">
                    <span className="scene-number">
                      {t('ws.board.sceneTag', {
                        number: String(scene.sceneNumber).padStart(2, '0'),
                        start,
                        end,
                      })}
                    </span>
                    {keyframe ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
                      <img
                        src={assetContentUrl(keyframe.id)}
                        alt={t('ws.board.keyframeAlt', { number: scene.sceneNumber })}
                        loading="lazy"
                      />
                    ) : (
                      <span>{t('ws.board.noKeyframe')}</span>
                    )}
                  </div>
                  <div className="scene-body">
                    <h4>
                      {scene.shotType}, {scene.cameraAngle}
                    </h4>
                    <p>{scene.visualDescription}</p>
                    {scene.voiceOverSegment && <p>“{scene.voiceOverSegment}”</p>}
                    <p className="prompt">
                      <span className="script-label">{t('ws.board.imagePrompt')}</span>
                      {scene.imagePrompt}
                    </p>
                    <div className="scene-foot">
                      <span className="tag">{scene.cameraMovement}</span>
                      {canEdit && <SceneEditor scene={scene} />}
                      {canEdit && (
                        <SceneReferencesButton scene={scene} projectId={content.projectId} />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        }
        side={
          <>
            {canEdit && board.status === 'pending_review' && !board.stale && (
              <ReviewPanel
                kind="storyboards"
                id={board.id}
                what={t('review.what.storyboard')}
                gate={t('review.gate', { number: 2, name: t('ws.check.storyboardApproval') })}
                items={boardChecks}
              />
            )}
            {briefCard}
          </>
        }
      />
      {canEdit && generateStoryboard && <div className="review-actions">{generateStoryboard}</div>}
      {earlierStoryboards}
    </article>
  ) : (
    <section className="card work-card">
      <div className="section-head">
        <div>
          <h2>{t('ws.board.empty')}</h2>
          <p>{t('ws.board.emptyHint')}</p>
        </div>
      </div>
      {content.status === 'storyboarding' && (
        <p className="notice" role="status">
          {t('ws.board.generating')}
        </p>
      )}
      <div className="empty">{approvedScript ? t('ws.board.none') : t('ws.board.locked')}</div>
      {generateStoryboard && <div className="review-actions">{generateStoryboard}</div>}
    </section>
  );

  const sceneBriefs: Record<string, SceneBrief> = Object.fromEntries(
    (board && imageData && board.id === imageData.storyboardVersionId ? board.scenes : []).map(
      (sc) => [
        sc.id,
        {
          title:
            sc.visualDescription.length > 90
              ? `${sc.visualDescription.slice(0, 88)}…`
              : sc.visualDescription,
          detail: `${String(sc.durationSeconds)} s · ${sc.shotType} · ${sc.cameraMovement}`,
        },
      ],
    ),
  );
  const scenesPanel = (
    <>
      {canEdit && imageData && imageData.scenes.length > 0 && (
        <KeyframeReview
          images={imageData}
          scenes={sceneBriefs}
          subtitle={`${content.title} · ${projectName}`}
          clips={{ done: clipCount, total: sceneCount }}
          voice={{
            done: voiceCount,
            total: voiceScenes.length,
            enabled: content.voiceEnabled,
          }}
          confirmThresholdUsd={threshold}
        />
      )}
      <ScenesTab
        contentId={content.id}
        canEdit={canEdit}
        images={imageData}
        videos={videoData}
        voiceovers={voiceData}
        locked={!images || !videos || !voiceovers}
        loadFailed={
          Boolean(images && !imageData) ||
          Boolean(videos && !videoData) ||
          Boolean(voiceovers && !voiceData)
        }
        generating={content.status === 'generating_assets'}
        imageModels={optionsOf(imageModels)}
        videoModels={optionsOf(videoModels)}
        profiles={profileList}
        initialStage={initialStage}
        voiceEnabled={content.voiceEnabled}
        confirmThresholdUsd={threshold}
      />
    </>
  );

  const renderPanel = (
    <section>
      {!plan ? (
        <p className="notice error" role="alert">
          {t('ws.renderPlanError')}
        </p>
      ) : (
        <RenderPanel
          contentId={content.id}
          plan={plan}
          renders={renders}
          cost={costReport?.kind === 'ok' ? costReport.data : null}
          canEdit={canEdit}
          voiceEnabled={content.voiceEnabled}
        />
      )}
    </section>
  );

  const events = activityOf(t, locale, scriptList, storyboardList, [
    { kind: 'image', scenes: imageData?.scenes ?? [] },
    { kind: 'clip', scenes: videoData?.scenes ?? [] },
    { kind: 'voice', scenes: voiceData?.scenes ?? [] },
  ]);
  const sceneNumbers: Record<string, number> = Object.fromEntries(
    (imageData?.scenes ?? []).map((s) => [s.sceneId, s.sceneNumber]),
  );
  const models = (jobs: readonly GenerationJobDto[]) =>
    [...new Set(jobs.map((j) => j.modelKey))].join(', ') || t('ws.routing.none');
  const historyPanel = (
    <>
      <div className="routing" style={{ marginBottom: 18 }}>
        <span className="routing-label">{t('ws.routing')}</span>
        <dl>
          <dt>{t('ws.routing.script')}</dt>
          <dd>{scriptJobData?.modelKey ?? t('ws.routing.none')}</dd>
          <dt>{t('ws.routing.storyboard')}</dt>
          <dd>{storyboardJobData?.modelKey ?? t('ws.routing.none')}</dd>
          <dt>{t('ws.routing.images')}</dt>
          <dd>{models(imageJobs)}</dd>
          <dt>{t('ws.routing.clips')}</dt>
          <dd>{models(clipJobs)}</dd>
          <dt>{t('ws.routing.voice')}</dt>
          <dd>{models(voiceJobs)}</dd>
        </dl>
      </div>
      <JobActivity contentId={content.id} sceneNumbers={sceneNumbers} canEdit={canEdit} />
      <h3 style={{ marginTop: 24 }}>{t('ws.versionHistory')}</h3>
      {events.length === 0 ? (
        <div className="empty">{t('ws.nothingYet')}</div>
      ) : (
        <ul className="activity" style={{ marginTop: 18 }} aria-label={t('ws.versionHistory')}>
          {events.map((e) => (
            <li key={`${e.at}-${e.title}`} className="activity-item">
              <i className="activity-dot" aria-hidden="true" />
              <p>
                <b>{e.title}</b>
                <br />
                {e.detail} · <RelativeTime iso={e.at} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  // Stable ids (English) for nextStep(); labels are only shown through it.
  const checklist = [
    { label: 'Script generated', done: scriptList.length > 0, note: '' },
    { label: 'Script approval', done: approvedScript !== undefined, note: '' },
    { label: 'Storyboard approval', done: content.approvedStoryboardVersionId !== null, note: '' },
    { label: 'Keyframe selection', done: keyframesDone, note: '' },
    { label: 'Clip selection', done: videoData?.clipsComplete ?? false, note: '' },
    { label: 'Voice-over selection', done: voiceDone, note: '' },
    { label: 'Render & export', done: content.status === 'exported', note: '' },
  ].map((c) => ({ ...c, note: checkNote(c.label) }));
  function checkNote(label: string): string {
    switch (label) {
      case 'Script generated':
        return latestScript
          ? t('ws.checkNote.versions', { version: latestScript.version, count: scriptList.length })
          : t('ws.checkNote.fromBrief');
      case 'Script approval':
        return approvedScript
          ? t('ws.checkNote.inUse', { version: approvedScript.version })
          : t('ws.checkNote.waiting');
      case 'Storyboard approval':
        return content.approvedStoryboardVersionId
          ? t('ws.checkNote.boardInUse')
          : t('ws.checkNote.afterScript');
      case 'Keyframe selection':
        return imageData
          ? t('ws.checkNote.scenesChosen', { done: keyframeCount, total: sceneCount })
          : t('ws.checkNote.afterBoard');
      case 'Clip selection':
        return videoData
          ? t('ws.checkNote.scenesChosen', { done: clipCount, total: sceneCount })
          : t('ws.checkNote.afterBoard');
      case 'Voice-over selection':
        return !content.voiceEnabled
          ? t('ws.checkNote.voiceOff')
          : voiceData
            ? t('ws.checkNote.scenesChosen', { done: voiceCount, total: voiceScenes.length })
            : t('ws.checkNote.afterBoard');
      default:
        return content.status === 'exported'
          ? t('ws.note.exported')
          : approvedRender
            ? t('ws.checkNote.renderApproved')
            : renders.length > 0
              ? t('ws.checkNote.renders', { count: renders.length })
              : t('ws.checkNote.afterMedia');
    }
  }
  const next = nextStep(checklist, sceneRows, t);
  const costs = [scriptJobData, storyboardJobData, ...imageJobs, ...clipJobs, ...voiceJobs].flatMap(
    (j) => (j ? [j.cost] : []),
  );

  // --- Stage rail (R3): four stages, gates G1–G4.
  const scriptState: StageState = approvedScript ? 'done' : 'current';
  const boardState: StageState = content.approvedStoryboardVersionId
    ? 'done'
    : approvedScript
      ? 'current'
      : 'locked';
  const scenesState: StageState =
    keyframesDone && mediaDone ? 'done' : imageData ? 'current' : 'locked';
  const renderState: StageState =
    content.status === 'exported' ? 'done' : scenesState === 'done' ? 'current' : 'locked';
  const stages: WorkspaceStage[] = [
    {
      id: 'brief',
      label: t('ws.stage.brief'),
      state: 'done',
      note: content.masterBriefStale ? t('ws.masterChanged') : t('ws.note.briefSet'),
      panel: briefPanel,
    },
    {
      id: 'script',
      label: t('ws.stage.script'),
      state: scriptState,
      gate: t('ws.gate', { number: 1 }),
      note: approvedScript
        ? t('ws.note.approvedVersion', { version: approvedScript.version })
        : content.status === 'scripting'
          ? t('ws.note.generating')
          : latestScript?.status === 'pending_review'
            ? t('ws.note.reviewRequired')
            : t('ws.note.notStarted'),
      panel: scriptPanel,
    },
    {
      id: 'storyboard',
      label: t('ws.stage.storyboard'),
      state: boardState,
      gate: t('ws.gate', { number: 2 }),
      note: content.approvedStoryboardVersionId
        ? t('ws.note.approved')
        : !approvedScript
          ? t('ws.note.locked')
          : content.status === 'storyboarding'
            ? t('ws.note.generating')
            : board?.status === 'pending_review'
              ? t('ws.note.reviewRequired')
              : t('ws.note.notStarted'),
      panel: storyboardPanel,
    },
    {
      id: 'scenes',
      label: t('ws.stage.scenes'),
      state: scenesState,
      gate: t('ws.gate', { number: 3 }),
      note: !imageData
        ? t('ws.note.locked')
        : t('ws.note.scenesDone', { done: doneScenes, total: sceneRows.length }),
      badge: imageData ? `${String(doneScenes)}/${String(sceneRows.length)}` : undefined,
      panel: scenesPanel,
    },
    {
      id: 'render',
      label: t('ws.stage.render'),
      state: renderState,
      gate: t('ws.gate', { number: 4 }),
      note:
        content.status === 'exported'
          ? t('ws.note.exported')
          : approvedRender
            ? t('ws.note.readyToExport')
            : renders.length > 0
              ? t('ws.note.renderReview')
              : plan?.blockers.length === 0
                ? t('ws.note.readyToRender')
                : t('ws.note.locked'),
      badge: renders.length > 0 ? String(renders.length) : undefined,
      panel: renderPanel,
    },
    {
      id: 'export',
      label: t('ws.stage.export'),
      state: content.status === 'exported' ? 'done' : approvedRender ? 'current' : 'locked',
      note:
        content.status === 'exported'
          ? t('ws.note.exported')
          : approvedRender
            ? t('ws.note.readyToExport')
            : '—',
      panel: (
        <section className="card pad col export-panel" aria-label={t('ws.stage.export')}>
          <h3>{t('ws.export.title')}</h3>
          <p className="muted t-13">
            {content.status === 'exported'
              ? t('ws.export.done')
              : approvedRender
                ? t('ws.export.ready')
                : t('ws.export.locked')}
          </p>
          <a className="btn primary" href="#render">
            <Icon name="download" /> {t('ws.export.open')}
          </a>
        </section>
      ),
    },
  ];
  const totalCost = costs.length > 0 ? sumJobCosts(costs) : null;
  const remaining = checklist.filter((c) => !c.done).length;
  const nextBar = next ? (
    <NextStepBar
      label={t('ws.nextStepOf', { current: 1, total: Math.max(1, remaining) })}
      title={next.title}
      detail={next.detail}
      action={next.action}
      href={`#${next.tab}${next.filter ? `?filter=${next.filter}` : ''}`}
      skip={t('ws.skip')}
      ariaLabel={t('ws.nextStep')}
    />
  ) : (
    <section className="actionbar" aria-label={t('ws.nextStep')}>
      <Icon name="check" size={24} />
      <div className="col actionbar-text">
        <span className="lbl">{t('ws.allDoneTitle')}</span>
        <b>{t('ws.allDoneBody')}</b>
      </div>
    </section>
  );
  const info = statusInfo(content.status);
  const voiceProfile = profileList.find((p) => p.id === content.voiceProfileId);
  const photos = content.brief.productAssetIds?.length ?? 0;
  const subtitle = [
    projectName,
    platformLabel(t, content.targetPlatform),
    t('ws.brief.seconds', { count: content.targetDurationSeconds }),
    content.aspectRatio,
    content.language.toUpperCase(),
    content.voiceEnabled
      ? voiceProfile
        ? t('ws.head.voice', { name: voiceProfile.name })
        : t('ws.head.noVoice')
      : t('ws.head.voiceOff'),
    ...(photos > 0 ? [t('ws.head.photos', { count: photos })] : []),
  ].join(' · ');
  const stageCost = (jobs: readonly (GenerationJobDto | null | undefined)[]) => {
    const list = jobs.flatMap((j) => (j ? [j.cost] : []));
    return list.length > 0 ? sumJobCosts(list) : null;
  };
  const costText = (c: JobCostDto | null) =>
    c
      ? `${formatUsd(addUsd(c.reportedUsd, c.estimatedUsd))}${c.unknownCalls > 0 ? ' + ?' : ''}`
      : '$0.00';
  const costRows = [
    { label: t('ws.cost.text'), cost: stageCost([scriptJobData, storyboardJobData]) },
    { label: t('ws.cost.images', { count: imageJobs.length }), cost: stageCost(imageJobs) },
    { label: t('ws.cost.clips', { count: clipJobs.length }), cost: stageCost(clipJobs) },
    ...(content.voiceEnabled
      ? [{ label: t('ws.cost.voice', { count: voiceJobs.length }), cost: stageCost(voiceJobs) }]
      : []),
  ];

  return (
    <>
      <LiveRefresh contentId={content.id} />
      <PageCrumbs
        items={[{ label: t('nav.productions'), href: '/productions' }, { label: content.title }]}
      />
      <div className="page-head ws-head">
        <div className="col ws-title">
          <div className="row wrap">
            <h1>{content.title}</h1>
            <span
              className={`badge ${TONE_BADGE[info.tone] ?? 'neutral'}`}
              aria-label={t('ws.statusLabel')}
              role="status"
            >
              <Icon name={TONE_ICON[info.tone] ?? 'history'} size={13} />
              {t(info.label)}
            </span>
          </div>
          <p>
            <Link href={`/projects/${content.projectId}`}>{projectName}</Link>
            {' · '}
            {subtitle.slice(projectName.length + 3)} ·{' '}
            <Link href={`/masters/${content.contentMasterId}`}>{masterTitle}</Link>
          </p>
        </div>
        <span className="spacer" />
        <div className="row ws-head-actions">
          {totalCost && (
            <div className="col ws-spend">
              <span className="num">
                <b>
                  {formatUsd(addUsd(totalCost.reportedUsd, totalCost.estimatedUsd))}
                  {totalCost.unknownCalls > 0 ? ' + ?' : ''}
                </b>{' '}
                <span className="muted">{t('ws.spent')}</span>
              </span>
              {budget.kind === 'ok' && (
                <span className="t-12 muted">
                  {t('ws.budgetLeft', { amount: formatUsd(budget.data.remainingUsd) })}
                </span>
              )}
            </div>
          )}
          <HistoryDrawer>{historyPanel}</HistoryDrawer>
        </div>
      </div>

      <StageRail initial={initialTab} stages={stages} afterRail={nextBar} />

      <div className="row wrap ws-bottom">
        <section className="card ws-cost" aria-labelledby="ws-cost-head">
          <div className="card-head">
            <h3 id="ws-cost-head">{t('ws.cost.title')}</h3>
            <span className="spacer" />
            <Link className="t-13" href={`/projects/${content.projectId}/costs`}>
              {t('ws.cost.details')}
            </Link>
          </div>
          <div className="card-body col">
            <dl className="kv">
              {costRows.map((r) => (
                <Fragment key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{costText(r.cost)}</dd>
                </Fragment>
              ))}
            </dl>
            <div className="divider" />
            <div className="row">
              <b>{t('ws.cost.total')}</b>
              <span className="spacer" />
              <b className="num">{costText(totalCost)}</b>
            </div>
          </div>
        </section>
        <section className="card ws-activity" aria-labelledby="ws-activity-head">
          <div className="card-head">
            <h3 id="ws-activity-head">{t('ws.latestActivity')}</h3>
            <span className="spacer" />
            <a className="t-13" href="#activity">
              {t('ws.fullHistory')}
            </a>
          </div>
          <div className="card-body col">
            {events.length === 0 ? (
              <p className="muted t-13">{t('ws.nothingYet')}</p>
            ) : (
              events.slice(0, 4).map((e) => (
                <div key={`${e.at}-${e.title}`} className="ev">
                  <span className="d" aria-hidden="true" />
                  <span>
                    <b>{e.title}</b> {e.detail} ·{' '}
                    <span className="muted">
                      <RelativeTime iso={e.at} />
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}
