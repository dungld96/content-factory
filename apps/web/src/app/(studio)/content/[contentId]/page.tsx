import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

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

import { ProductPhotos } from '@/components/product-photos';
import { RelativeTime } from '@/components/local-time';
import { ReviewPanel } from '@/components/review/review-panel';
import { TextDiff } from '@/components/review/text-diff';
import { ContentStatusPill, Pill, VersionPill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { assetContentUrl } from '@/lib/asset-url';
import { formatLabel, jobErrorText, platformLabel, wordCount } from '@/lib/format';
import type { Locale, Translate } from '@/lib/i18n';
import { getLocale, getT } from '@/lib/i18n/server';
import { usableModels } from '@/lib/model-options';
import { addUsd, formatUsd, sumJobCosts } from '@/lib/money';
import { buildSceneRows, nextStep } from '@/lib/scene-board';

import { AudioPlan } from './audio-plan';
import { HistoryDrawer } from './history-drawer';
import { JobActivity } from './job-activity';
import { LiveRefresh } from './live-refresh';
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

function CostBox({ costs, t }: { readonly costs: readonly JobCostDto[]; readonly t: Translate }) {
  if (costs.length === 0) {
    return (
      <div className="cost-box">
        <span>{t('ws.costTitle')}</span>
        <strong>—</strong>
        <small>{t('ws.costNone')}</small>
      </div>
    );
  }
  const total = sumJobCosts(costs);
  const known = addUsd(total.reportedUsd, total.estimatedUsd);
  return (
    <div className="cost-box" aria-label={t('ws.cost')}>
      <span>{t('ws.costTitle')}</span>
      <strong>
        {formatUsd(known)}
        {total.unknownCalls > 0 ? ' +' : ''}
      </strong>
      <small>
        {t('ws.costParts', {
          reported: formatUsd(total.reportedUsd),
          estimated: formatUsd(total.estimatedUsd),
          calls: total.calls,
        })}
      </small>
      {total.unknownCalls > 0 && (
        <small className="unknown">{t('ws.costUnknown', { count: total.unknownCalls })}</small>
      )}
      <small>{t('ws.costNote')}</small>
    </div>
  );
}

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

  const scriptPanel = (
    <article
      className="card work-card"
      aria-label={
        latestScript ? t('ws.script.label', { version: latestScript.version }) : t('ws.script.none')
      }
    >
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

      {content.status === 'scripting' && (
        <p className="notice" role="status">
          {t('ws.generatingScript')}
        </p>
      )}

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
              <span className="script-label">{t('ws.hook')}</span>“{latestScript.content.hook}”
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

      {canEdit && latestScript?.status === 'pending_review' && (
        <ReviewPanel
          kind="scripts"
          id={latestScript.id}
          what={t('review.what.script')}
          gate={t('review.gate', { number: 1, name: t('ws.check.scriptApproval') })}
          items={scriptChecks}
        />
      )}
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
                  {canEdit && <SceneReferencesButton scene={scene} projectId={content.projectId} />}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {canEdit && board.status === 'pending_review' && !board.stale && (
        <ReviewPanel
          kind="storyboards"
          id={board.id}
          what={t('review.what.storyboard')}
          gate={t('review.gate', { number: 2, name: t('ws.check.storyboardApproval') })}
          items={boardChecks}
        />
      )}
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

  const scenesPanel = (
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
  );

  const renderPanel = (
    <section className="card work-card">
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
  ];
  const totalCost = costs.length > 0 ? sumJobCosts(costs) : null;

  return (
    <>
      <LiveRefresh contentId={content.id} />
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href={`/projects/${content.projectId}`}>{projectName}</Link> /{' '}
            <Link href={`/masters/${content.contentMasterId}`}>{masterTitle}</Link>
          </div>
          <h1>{content.title}</h1>
          <p>
            {t('ws.subtitle', {
              format: formatLabel(t, content.format),
              platform: platformLabel(t, content.targetPlatform),
              seconds: content.targetDurationSeconds,
            })}{' '}
            <RelativeTime iso={content.updatedAt} />
          </p>
        </div>
        <div className="actions">
          <ContentStatusPill status={content.status} label={t('ws.statusLabel')} />
          <HistoryDrawer>{historyPanel}</HistoryDrawer>
        </div>
      </div>

      {next ? (
        <section className="card action-bar next-step" aria-label={t('ws.nextStep')}>
          <span className="next-text">
            <span className="eyebrow">{t('ws.nextStep')}</span>
            <b>{next.title}</b>
            <span className="muted">{next.detail}</span>
          </span>
          {totalCost && (
            <span className="next-cost">
              {t('ws.cost')}: {formatUsd(addUsd(totalCost.reportedUsd, totalCost.estimatedUsd))}
              {totalCost.unknownCalls > 0 ? ' + ?' : ''}
            </span>
          )}
          <a
            className="btn primary"
            href={`#${next.tab}${next.filter ? `?filter=${next.filter}` : ''}`}
          >
            {next.action}
          </a>
        </section>
      ) : (
        <section className="card action-bar next-step" aria-label={t('ws.nextStep')}>
          <span className="next-text">
            <span className="eyebrow">{t('ws.allDoneTitle')}</span>
            <b>{t('ws.allDoneBody')}</b>
          </span>
        </section>
      )}

      <StageRail initial={initialTab} stages={stages} />

      <section className="card cost-card workspace-cost" aria-label={t('ws.cost')}>
        <CostBox costs={costs} t={t} />
      </section>
    </>
  );
}
