import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type {
  AiModelDto,
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

import { Icon } from '@/components/icon';
import { buildSceneRows, nextStep } from '@/lib/scene-board';
import { RelativeTime } from '@/components/local-time';
import { ContentStatusPill, Pill, VersionPill } from '@/components/status-pill';
import { assetContentUrl } from '@/lib/asset-url';
import { isGenerating } from '@/lib/content-status';
import { FORMAT_LABEL, jobErrorText, platformLabel, wordCount } from '@/lib/format';
import { usableModels } from '@/lib/model-options';
import { addUsd, formatUsd, sumJobCosts } from '@/lib/money';
import { apiGet } from '@/lib/api-server';

import {
  AutoRefresh,
  BriefCheck,
  GenerateButton,
  ReviewButtons,
  SceneEditor,
  SceneReferencesButton,
  ScriptEditor,
} from './pipeline-controls';
import { RenderPanel } from './render-panel';
import { ResyncBriefButton } from './scene-images';
import { AudioPlan } from './audio-plan';
import { ScenesTab } from './scenes-tab';
import { JobActivity } from './job-activity';
import { WorkspaceTabs } from './workspace-tabs';

export const metadata: Metadata = { title: 'Content · Content Studio' };
export const dynamic = 'force-dynamic';

type TabId = 'script' | 'storyboard' | 'scenes' | 'render' | 'activity';

interface Step {
  readonly label: string;
  readonly done: boolean;
  readonly note: string;
}

function Workflow({ steps }: { readonly steps: readonly Step[] }) {
  const current = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const now = steps[current];
  return (
    <>
      {/* Phones (UX review U4): one line and a progress bar instead of six steps. */}
      <div className="card workflow-compact" aria-hidden="true">
        <b>
          {now
            ? `Step ${String(current + 1)} of ${String(steps.length)} · ${now.label}`
            : 'All steps done'}
        </b>
        <span className="muted small-text">{now?.note ?? 'Exported'}</span>
        <span className="bar-track">
          <span
            className="bar-fill"
            style={{ display: 'block', width: `${String((doneCount / steps.length) * 100)}%` }}
          />
        </span>
      </div>
      <ol className="card workflow" aria-label="Production steps">
        {steps.map((step, i) => {
          const state = step.done ? 'done' : i === current ? 'current' : '';
          return (
            <li key={step.label} style={{ display: 'contents' }}>
              {i > 0 && <span className="step-line" aria-hidden="true" />}
              <span
                className={`step ${state}`}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="step-circle" aria-hidden="true">
                  {step.done ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <span>
                  <b>{step.label}</b>
                  <small>{step.note}</small>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function CostBox({ costs }: { readonly costs: readonly JobCostDto[] }) {
  if (costs.length === 0) {
    return (
      <div className="cost-box">
        <span>Cost of the latest generation jobs</span>
        <strong>—</strong>
        <small>No generation job has run yet.</small>
      </div>
    );
  }
  const total = sumJobCosts(costs);
  const known = addUsd(total.reportedUsd, total.estimatedUsd);
  return (
    <div className="cost-box" aria-label="Generation cost">
      <span>Cost of the latest generation jobs</span>
      <strong>
        {formatUsd(known)}
        {total.unknownCalls > 0 ? ' +' : ''}
      </strong>
      <small>
        Reported {formatUsd(total.reportedUsd)} · estimated {formatUsd(total.estimatedUsd)} ·{' '}
        {total.calls} call{total.calls === 1 ? '' : 's'}
      </small>
      {total.unknownCalls > 0 && (
        <small className="unknown">
          {total.unknownCalls} call{total.unknownCalls === 1 ? '' : 's'} of unknown cost (not
          included)
        </small>
      )}
      <small>Earlier runs and regenerations are not included.</small>
    </div>
  );
}

interface ActivityEvent {
  readonly at: string;
  readonly title: string;
  readonly detail: string;
}

function activityOf(
  scripts: readonly ScriptVersionDto[],
  storyboards: readonly StoryboardVersionDto[],
  images: StoryboardImagesDto | null,
  media: readonly { kind: string; scenes: readonly SceneJobs[] }[] = [],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const review = (kind: string, v: ScriptVersionDto | StoryboardVersionDto) => {
    if (v.reviewedAt && v.status !== 'pending_review') {
      events.push({
        at: v.reviewedAt,
        title: `${kind} v${String(v.version)} ${v.status === 'approved' ? 'approved' : 'rejected'}`,
        detail: v.reviewNote ? `Review note: ${v.reviewNote}` : 'Review decision recorded',
      });
    }
  };
  for (const s of scripts) {
    events.push({
      at: s.createdAt,
      title: `Script v${String(s.version)} ${s.source === 'generated' ? 'generated' : 'edited'}`,
      detail: s.basedOnVersionId ? 'Based on an earlier version' : s.content.title,
    });
    review('Script', s);
  }
  for (const b of storyboards) {
    events.push({
      at: b.createdAt,
      title: `Storyboard v${String(b.version)} ${b.source === 'generated' ? 'generated' : 'edited'}`,
      detail: `${String(b.totalDurationSeconds)}s${b.stale ? ' · based on an older script' : ''}`,
    });
    review('Storyboard', b);
  }
  for (const scene of images?.scenes ?? []) {
    const job = scene.activeJob ?? scene.lastJob;
    if (job) {
      events.push({
        at: job.completedAt ?? job.startedAt ?? job.queuedAt,
        title: `Scene ${String(scene.sceneNumber)} image job ${job.status}`,
        detail: `${job.modelKey}${job.errorCode ? ` · ${jobErrorText(job.errorCode)}` : ''}`,
      });
    }
  }
  for (const { kind, scenes } of media) {
    for (const scene of scenes) {
      const job = scene.activeJob ?? scene.lastJob;
      if (job) {
        events.push({
          at: job.completedAt ?? job.startedAt ?? job.queuedAt,
          title: `Scene ${String(scene.sceneNumber)} ${kind} job ${job.status}`,
          detail: `${job.modelKey}${job.errorCode ? ` · ${jobErrorText(job.errorCode)}` : ''}`,
        });
      }
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

interface SceneJobs {
  readonly sceneNumber: number;
  readonly activeJob: GenerationJobDto | null;
  readonly lastJob: GenerationJobDto | null;
}

const jobsOf = (scenes: readonly SceneJobs[] | undefined): GenerationJobDto[] =>
  (scenes ?? []).flatMap((s) => {
    const job = s.activeJob ?? s.lastJob;
    return job ? [job] : [];
  });

const STATUS_TEXT: Readonly<Record<'pending_review' | 'approved' | 'rejected', string>> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export default async function ContentPage({
  params,
}: {
  readonly params: Promise<{ contentId: string }>;
}) {
  const { contentId } = await params;
  const item = await apiGet<ContentItemDto>(`/content/${contentId}`);
  if (item.kind === 'unauthenticated') redirect('/login');
  if (item.kind === 'error') {
    if (item.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        The content item could not be loaded.
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
  const projectName = project.kind === 'ok' ? project.data.name : 'Project';
  const masterTitle = master.kind === 'ok' ? master.data.title : 'its content master';
  const keyframeCount = imageData?.scenes.filter((s) => s.keyframe !== null).length ?? 0;
  const sceneCount = imageData?.scenes.length ?? board?.scenes.length ?? 0;
  const keyframesDone = imageData?.keyframesComplete ?? false;
  const latestScriptJob = latestScript?.generationJobId === scriptJobId ? scriptJobData : null;

  // P4d: with voice-over off, the voice-over stage is complete by definition.
  const voiceDone = !content.voiceEnabled || (voiceData?.voiceoversComplete ?? false);
  const steps: Step[] = [
    {
      label: 'Brief',
      done: scriptList.length > 0,
      note: scriptList.length > 0 ? 'Used for a script' : 'Ready to generate',
    },
    {
      label: 'Script',
      done: approvedScript !== undefined,
      note: approvedScript
        ? `v${String(approvedScript.version)} approved`
        : content.status === 'scripting'
          ? 'Generating…'
          : latestScript?.status === 'pending_review'
            ? 'Review required'
            : 'Not started',
    },
    {
      label: 'Storyboard',
      done: content.approvedStoryboardVersionId !== null,
      note: content.approvedStoryboardVersionId
        ? 'Approved'
        : !approvedScript
          ? 'Locked'
          : content.status === 'storyboarding'
            ? 'Generating…'
            : board?.status === 'pending_review'
              ? 'Review required'
              : 'Not started',
    },
    {
      label: 'Keyframes',
      done: keyframesDone,
      note: !imageData ? 'Locked' : `${String(keyframeCount)} of ${String(sceneCount)} scenes`,
    },
    {
      label: 'Clips & voice',
      done: (videoData?.clipsComplete ?? false) && voiceDone,
      note: !videoData
        ? 'Locked'
        : content.voiceEnabled
          ? `${String(clipCount)} clip(s) · ${String(voiceCount)} voice-over(s)`
          : `${String(clipCount)} clip(s) · no voice-over`,
    },
    {
      label: 'Export',
      done: content.status === 'exported',
      note:
        content.status === 'exported'
          ? 'Exported'
          : approvedRender
            ? 'Approved, ready to export'
            : renders.length > 0
              ? 'Render review'
              : plan?.blockers.length === 0
                ? 'Ready to render'
                : 'Locked',
    },
  ];
  const mediaDone = (videoData?.clipsComplete ?? false) && voiceDone;
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

  const scriptPanel = (
    <article
      className="card work-card"
      aria-label={latestScript ? `Script version ${String(latestScript.version)}` : 'Script'}
    >
      <div className="section-head">
        <div>
          <h2>{latestScript ? `Script review · ${latestScript.content.title}` : 'Script'}</h2>
          <p>
            {latestScript ? (
              <>
                Version {latestScript.version} ·{' '}
                {latestScript.source === 'generated' ? 'Generated' : 'Edited'}
                {latestScriptJob ? ` by ${latestScriptJob.modelKey}` : ''} ·{' '}
                <RelativeTime iso={latestScript.createdAt} />
              </>
            ) : (
              'Generate a script from the brief.'
            )}
          </p>
        </div>
        {latestScript && (
          <span className="actions">
            <VersionPill status={latestScript.status} />
            {latestScript.isApproved && <Pill tone="green">In use</Pill>}
          </span>
        )}
      </div>

      <div className="brief-box">
        <span className="box-label">Content brief</span>
        <p>{content.brief.topic}</p>
        <div className="tags">
          {content.brief.audience && (
            <span className="tag">Audience · {content.brief.audience}</span>
          )}
          {content.brief.tone && <span className="tag">Tone · {content.brief.tone}</span>}
          {content.brief.objective && (
            <span className="tag">Objective · {content.brief.objective}</span>
          )}
          <span className="tag">{content.targetDurationSeconds} sec</span>
          <span className="tag">{content.aspectRatio}</span>
          <span className="tag">{content.language.toUpperCase()}</span>
        </div>
        <p className="brief-meta" aria-label="Content master">
          Variant of <Link href={`/masters/${content.contentMasterId}`}>{masterTitle}</Link>
          {content.targetPlatform ? ` · for ${platformLabel(content.targetPlatform)}` : ''}{' '}
          {content.masterBriefStale && <Pill tone="amber">Master brief changed</Pill>}
        </p>
        {canEdit && content.masterBriefStale && (
          <div className="review-actions">
            <ResyncBriefButton contentId={content.id} />
          </div>
        )}
        <BriefCheck contentId={content.id} />
        <AudioPlan contentId={content.id} voiceEnabled={content.voiceEnabled} canEdit={canEdit} />
      </div>

      {content.status === 'scripting' && (
        <p className="notice" role="status">
          Generating a script…
        </p>
      )}

      {latestScript ? (
        <>
          <div className="script-block">
            <div className="script-block-head">
              <h3>Creative direction</h3>
            </div>
            <p>
              <span className="script-label">Angle</span>
              {latestScript.content.plan.angle}
            </p>
            <p>
              <span className="script-label">Hook</span>“{latestScript.content.hook}”
            </p>
          </div>
          <div className="script-block">
            <div className="script-block-head">
              <h3>Voice-over script</h3>
            </div>
            <p>“{latestScript.content.voiceOver}”</p>
            <p className="muted small-text">
              {wordCount(latestScript.content.voiceOver)} words · target{' '}
              {content.targetDurationSeconds} seconds
            </p>
          </div>
          <div className="script-block">
            <div className="script-block-head">
              <h3>Call to action</h3>
            </div>
            <p>“{latestScript.content.callToAction}”</p>
          </div>
          {latestScript.content.claimsRequiringVerification.length > 0 && (
            <div className="script-block">
              <div className="script-block-head">
                <h3>Claims to verify</h3>
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
            <p className="muted small-text">Review note: {latestScript.reviewNote}</p>
          )}
        </>
      ) : (
        <div className="empty">No script yet.</div>
      )}

      {canEdit && (
        <div className="review-actions">
          {latestScript?.status === 'pending_review' && (
            <ReviewButtons kind="scripts" id={latestScript.id} label="script" />
          )}
          {latestScript && <ScriptEditor script={latestScript} />}
          <GenerateButton
            path={`/content/${content.id}/scripts/generate`}
            label={latestScript ? 'Regenerate script' : 'Generate script'}
            again={latestScript !== undefined}
            primary={!latestScript}
            models={optionsOf(textModels)}
          />
        </div>
      )}

      {scriptList.length > 1 && (
        <details className="earlier-versions">
          <summary>Earlier versions ({scriptList.length - 1})</summary>
          <ul className="plain-list" aria-label="Earlier script versions">
            {scriptList.slice(1).map((v) => (
              <li key={v.id} aria-label={`Script version ${String(v.version)}`}>
                <p className="small-text">
                  <b>Version {v.version}</b> · {v.source === 'edited' ? 'Edited' : 'Generated'} ·{' '}
                  {v.isApproved ? 'Approved, in use' : STATUS_TEXT[v.status]} ·{' '}
                  {v.content.voiceOver.trim().split(/\s+/).length} words
                </p>
                <p className="small-text">
                  <b>Hook:</b> “{v.content.hook}”
                </p>
                <p className="small-text muted">“{v.content.voiceOver}”</p>
                {canEdit && v.status === 'pending_review' && (
                  <div className="review-actions">
                    <ReviewButtons
                      kind="scripts"
                      id={v.id}
                      label={`script v${String(v.version)}`}
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
        <summary>Earlier storyboard versions ({storyboardList.length - 1})</summary>
        <ul className="plain-list" aria-label="Earlier storyboard versions">
          {storyboardList.slice(1).map((v) => (
            <li key={v.id} aria-label={`Storyboard version ${String(v.version)}`}>
              <p className="small-text">
                <b>Version {v.version}</b> · {v.source === 'edited' ? 'Edited' : 'Generated'} ·{' '}
                {v.totalDurationSeconds} s ·{' '}
                {v.isApproved
                  ? 'Approved, in use'
                  : v.stale
                    ? 'Stale (older script)'
                    : STATUS_TEXT[v.status]}
              </p>
              {canEdit && v.status === 'pending_review' && !v.stale && (
                <div className="review-actions">
                  <ReviewButtons
                    kind="storyboards"
                    id={v.id}
                    label={`storyboard v${String(v.version)}`}
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
        label={storyboardList.length > 0 ? 'Regenerate storyboard' : 'Generate storyboard'}
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
    <article className="card work-card" aria-label={`Storyboard version ${String(board.version)}`}>
      <div className="section-head">
        <div>
          <h2>Storyboard · Version {board.version}</h2>
          <p>
            {board.scenes.length} scenes · {board.totalDurationSeconds} seconds total ·{' '}
            {board.source === 'generated' ? 'Generated' : 'Edited'}{' '}
            <RelativeTime iso={board.createdAt} />
          </p>
        </div>
        <span className="actions">
          <VersionPill status={board.status} />
          {board.stale && <Pill tone="amber">Stale (older script)</Pill>}
          {board.isApproved && <Pill tone="green">In use</Pill>}
        </span>
      </div>
      {content.status === 'storyboarding' && (
        <p className="notice" role="status">
          Generating a storyboard…
        </p>
      )}
      <ul className="storyboard-grid" aria-label="Scenes">
        {board.scenes.map((scene, i) => {
          const start = sceneStarts[i] ?? 0;
          const end = start + scene.durationSeconds;
          const keyframe = keyframeByScene.get(scene.id);
          return (
            <li key={scene.id} className="scene-card">
              <div className="scene-art">
                <span className="scene-number">
                  SCENE {String(scene.sceneNumber).padStart(2, '0')} · {start}–{end}s
                </span>
                {keyframe ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
                  <img
                    src={assetContentUrl(keyframe.id)}
                    alt={`Scene ${String(scene.sceneNumber)} keyframe`}
                    loading="lazy"
                  />
                ) : (
                  <span>No keyframe yet</span>
                )}
              </div>
              <div className="scene-body">
                <h4>
                  {scene.shotType}, {scene.cameraAngle}
                </h4>
                <p>{scene.visualDescription}</p>
                {scene.voiceOverSegment && <p>“{scene.voiceOverSegment}”</p>}
                <p className="prompt">
                  <span className="script-label">Image prompt</span>
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
      {canEdit && (
        <div className="review-actions">
          {board.status === 'pending_review' && !board.stale && (
            <ReviewButtons kind="storyboards" id={board.id} label="storyboard" />
          )}
          {generateStoryboard}
        </div>
      )}
      {earlierStoryboards}
    </article>
  ) : (
    <section className="card work-card">
      <div className="section-head">
        <div>
          <h2>Storyboard</h2>
          <p>Scenes, shots and prompts derived from the approved script.</p>
        </div>
      </div>
      {content.status === 'storyboarding' && (
        <p className="notice" role="status">
          Generating a storyboard…
        </p>
      )}
      <div className="empty">
        {approvedScript ? 'No storyboard yet.' : 'Approve a script first (gate 1).'}
      </div>
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
    />
  );

  const renderPanel = (
    <section className="card work-card">
      {!plan ? (
        <p className="notice error" role="alert">
          The render plan could not be loaded.
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

  const events = activityOf(scriptList, storyboardList, imageData, [
    { kind: 'clip', scenes: videoData?.scenes ?? [] },
    { kind: 'voice-over', scenes: voiceData?.scenes ?? [] },
  ]);
  const sceneNumbers: Record<string, number> = Object.fromEntries(
    (imageData?.scenes ?? []).map((s) => [s.sceneId, s.sceneNumber]),
  );
  const activityPanel = (
    <section className="card work-card">
      <h2>Activity & version history</h2>
      <div className="routing" style={{ marginBottom: 18 }}>
        <span className="routing-label">Model routing (latest jobs)</span>
        <dl>
          <dt>Script</dt>
          <dd>{scriptJobData?.modelKey ?? 'Not generated yet'}</dd>
          <dt>Storyboard</dt>
          <dd>{storyboardJobData?.modelKey ?? 'Not generated yet'}</dd>
          <dt>Images</dt>
          <dd>
            {[...new Set(imageJobs.map((j) => j.modelKey))].join(', ') || 'Not generated yet'}
          </dd>
          <dt>Clips</dt>
          <dd>{[...new Set(clipJobs.map((j) => j.modelKey))].join(', ') || 'Not generated yet'}</dd>
          <dt>Voice-over</dt>
          <dd>
            {[...new Set(voiceJobs.map((j) => j.modelKey))].join(', ') || 'Not generated yet'}
          </dd>
        </dl>
      </div>
      <JobActivity contentId={content.id} sceneNumbers={sceneNumbers} canEdit={canEdit} />
      <h3 style={{ marginTop: 24 }}>Version history</h3>
      {events.length === 0 ? (
        <div className="empty">Nothing has happened yet.</div>
      ) : (
        <ul className="activity" style={{ marginTop: 18 }} aria-label="Version history">
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
    </section>
  );

  const checklist = [
    {
      label: 'Script generated',
      done: scriptList.length > 0,
      note: latestScript
        ? `Version ${String(latestScript.version)} · ${String(scriptList.length)} version(s)`
        : 'From the validated brief',
    },
    {
      label: 'Script approval',
      done: approvedScript !== undefined,
      note: approvedScript
        ? `Version ${String(approvedScript.version)} in use`
        : 'Waiting for review',
    },
    {
      label: 'Storyboard approval',
      done: content.approvedStoryboardVersionId !== null,
      note: content.approvedStoryboardVersionId
        ? 'Approved storyboard in use'
        : 'Unlocks after script approval',
    },
    {
      label: 'Keyframe selection',
      done: keyframesDone,
      note: imageData
        ? `${String(keyframeCount)} of ${String(sceneCount)} scenes chosen`
        : 'Unlocks after storyboard approval',
    },
    {
      label: 'Clip selection',
      done: videoData?.clipsComplete ?? false,
      note: videoData
        ? `${String(clipCount)} of ${String(sceneCount)} scenes chosen`
        : 'Unlocks after storyboard approval',
    },
    {
      label: 'Voice-over selection',
      done: voiceDone,
      note: !content.voiceEnabled
        ? 'Voice-over is off'
        : voiceData
          ? `${String(voiceCount)} of ${String(voiceScenes.length)} scenes chosen`
          : 'Unlocks after storyboard approval',
    },
    {
      label: 'Render & export',
      done: content.status === 'exported',
      note:
        content.status === 'exported'
          ? 'Exported'
          : approvedRender
            ? 'Render approved'
            : renders.length > 0
              ? `${String(renders.length)} render(s), review required`
              : 'Unlocks with every clip and voice-over',
    },
  ];
  const sceneRows = buildSceneRows(imageData, videoData, voiceData, content.voiceEnabled);
  const next = nextStep(checklist, sceneRows);
  const costs = [scriptJobData, storyboardJobData, ...imageJobs, ...clipJobs, ...voiceJobs].flatMap(
    (j) => (j ? [j.cost] : []),
  );

  return (
    <>
      <AutoRefresh active={isGenerating(content.status)} />
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href={`/projects/${content.projectId}`}>{projectName}</Link> /{' '}
            <Link href={`/masters/${content.contentMasterId}`}>{masterTitle}</Link>
          </div>
          <h1>{content.title}</h1>
          <p>
            {FORMAT_LABEL[content.format]} · {platformLabel(content.targetPlatform)} ·{' '}
            {content.targetDurationSeconds} seconds · Updated{' '}
            <RelativeTime iso={content.updatedAt} />
          </p>
        </div>
        <div className="actions">
          <ContentStatusPill status={content.status} label="Content status" />
          <a className="btn" href="#activity">
            <Icon name="history" /> Version history
          </a>
        </div>
      </div>

      <Workflow steps={steps} />

      <div className="content-main-grid">
        <div>
          <WorkspaceTabs
            initial={initialTab}
            tabs={[
              { id: 'script', label: 'Script & brief', panel: scriptPanel },
              { id: 'storyboard', label: 'Storyboard', panel: storyboardPanel },
              {
                id: 'scenes',
                label: 'Scenes',
                badge: imageData
                  ? `${String(sceneRows.filter((r) => r.status === 'done').length)}/${String(sceneRows.length)}`
                  : undefined,
                panel: scenesPanel,
              },
              {
                id: 'render',
                label: 'Render & export',
                badge: renders.length > 0 ? String(renders.length) : undefined,
                panel: renderPanel,
              },
              { id: 'activity', label: 'Activity', panel: activityPanel },
            ]}
          />
        </div>
        <aside className="side-stack">
          {next ? (
            <section className="card card-pad next-step" aria-label="Next step">
              <p className="eyebrow">Next step</p>
              <b>{next.title}</b>
              <span className="muted">{next.detail}</span>
              <a
                className="btn primary"
                href={`#${next.tab}${next.filter ? `?filter=${next.filter}` : ''}`}
              >
                {next.action}
              </a>
            </section>
          ) : (
            <section className="card card-pad next-step" aria-label="Next step">
              <p className="eyebrow">All done</p>
              <b>Every gate is passed and the video is exported.</b>
            </section>
          )}
          <section className="card cost-card" aria-label="Cost">
            <CostBox costs={costs} />
          </section>
        </aside>
      </div>
    </>
  );
}
