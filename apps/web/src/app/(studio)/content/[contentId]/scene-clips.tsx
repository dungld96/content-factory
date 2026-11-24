'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type {
  AssetDto,
  GenerationJobDto,
  StoryboardVideosDto,
  VideoEstimateDto,
  VideoGenerateResponseDto,
} from '@acf/contracts';

import { CancelActiveRuns } from '@/components/cancel-run';
import { CostConfirmDialog, estimateText } from '@/components/cost-confirm';
import { DeliveredOutputActions, JobErrorDetail } from '@/components/delivered-output';
import { useLocale, useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { ModelSelect, type ModelOption } from '@/components/model-select';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { confirmReasons, type ConfirmReason } from '@/lib/cost-confirm';
import { formatSeconds, jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

type Resolution = VideoEstimateDto['resolution'];
type Scope = Readonly<Record<string, unknown>>;

/**
 * Scene clips (M5 design §6, §12; redesign R-D4): the button shows the estimated price, a click
 * at or below the cost threshold with known prices generates at once (with the confirmed
 * estimate the API checks), anything above it or with an unknown price asks first. Then follow
 * provider progress, review candidates and choose each scene's clip (gate 3).
 */
export function SceneClipsPanel(props: {
  readonly videos: StoryboardVideosDto;
  readonly canEdit: boolean;
  /** Show only this scene (the Scenes board's selected row); null shows every scene. */
  readonly onlySceneId?: string | null;
  /** Enabled video models the editor may pick instead of the task route. */
  readonly models?: readonly ModelOption[];
  /** R-D4: the effective cost-confirmation threshold (USD). */
  readonly confirmThresholdUsd?: string;
}) {
  const t = useT();
  const router = useRouter();
  const { videos, canEdit } = props;
  const threshold = props.confirmThresholdUsd ?? '1';
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [modelKey, setModelKey] = useState('');
  const [estimate, setEstimate] = useState<VideoEstimateDto | null>(null);
  const [pending, setPending] = useState<{
    plan: VideoEstimateDto;
    scope: Scope;
    reasons: ConfirmReason[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withClip = videos.scenes.filter((s) => s.clip !== null).length;

  async function run<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await mutate<T>(method, path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? t('form.requestFailed', { status: r.status }));
      return null;
    }
    return r.data;
  }

  const estimateFor = useCallback(
    async (scope: Scope): Promise<VideoEstimateDto | null> => {
      const r = await mutate<VideoEstimateDto>(
        'POST',
        `/storyboards/${videos.storyboardVersionId}/videos/estimate`,
        { resolution, ...(modelKey ? { modelKey } : {}), ...scope },
      );
      return r.ok ? r.data : null;
    },
    [videos.storyboardVersionId, resolution, modelKey],
  );

  // The price on the button: estimate the whole storyboard when the settings or the scenes'
  // clips and jobs change (not on every re-render).
  const shape = videos.scenes
    .map((s) => `${s.clip?.id ?? ''}:${s.activeJob?.id ?? ''}:${s.keyframe?.id ?? ''}`)
    .join(',');
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    void estimateFor({}).then((plan) => {
      if (live) setEstimate(plan);
    });
    return () => {
      live = false;
    };
  }, [canEdit, estimateFor, shape]);

  const toGenerate = (plan: VideoEstimateDto | null) =>
    plan?.scenes.filter((s) => s.action === 'generate') ?? [];
  const overBudget = (plan: VideoEstimateDto | null) =>
    plan !== null &&
    plan.totalEstimatedUsd !== null &&
    plan.requestBudgetUsd !== null &&
    Number(plan.totalEstimatedUsd) > Number(plan.requestBudgetUsd);

  async function generate(plan: VideoEstimateDto, scope: Scope) {
    setPending(null);
    const result = await run<VideoGenerateResponseDto>(
      'POST',
      `/storyboards/${videos.storyboardVersionId}/videos/generate`,
      {
        resolution,
        ...(modelKey ? { modelKey } : {}),
        ...scope,
        confirmedEstimateUsd: plan.totalEstimatedUsd,
        ...(plan.unknownCost ? { acceptUnknownCost: true } : {}),
      },
    );
    if (result) {
      setEstimate(result.estimate);
      toast(
        result.jobs.length > 0
          ? t('clips.queued', { count: result.jobs.length })
          : t('clips.nothing'),
      );
      router.refresh();
    }
  }

  /** Estimate `scope`, then generate at once or ask (R-D4). */
  async function start(scope: Scope) {
    setBusy(true);
    setError(null);
    const plan = await estimateFor(scope);
    setBusy(false);
    if (!plan) {
      setError(t('form.requestFailed', { status: 0 }));
      return;
    }
    if (Object.keys(scope).length === 0) setEstimate(plan);
    if (toGenerate(plan).length === 0) {
      toast(t('clips.nothing'));
      return;
    }
    if (overBudget(plan)) {
      setEstimate(plan);
      setError(t('clips.overBudget'));
      return;
    }
    const reasons = confirmReasons({
      totalUsd: plan.totalEstimatedUsd,
      unknown: plan.unknownCost,
      thresholdUsd: threshold,
    });
    if (reasons.length === 0) await generate(plan, scope);
    else setPending({ plan, scope, reasons });
  }

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    if ((await run(method, path, body)) !== null) router.refresh();
  }

  const planned = toGenerate(estimate);
  const buttonPrice =
    estimate && planned.length > 0
      ? ` · ${estimateText(estimate.totalEstimatedUsd, estimate.unknownCost)}`
      : '';

  return (
    <div aria-label={t('clips.controls')}>
      <div className="section-head">
        <div>
          <h2>{t('clips.title')}</h2>
          <p>{t('clips.hint')}</p>
        </div>
        <span
          className={videos.clipsComplete ? 'status green' : 'status gray'}
          aria-label={t('clips.gate')}
        >
          {videos.clipsComplete
            ? t('clips.complete')
            : t('clips.count', { done: withClip, total: videos.scenes.length })}
        </span>
      </div>
      {!videos.keyframesComplete && (
        <p className="notice" role="status">
          {t('clips.noKeyframes')}
        </p>
      )}
      {canEdit && (
        <div className="image-toolbar">
          <label className="field">
            {t('clips.resolution')}
            <select
              value={resolution}
              onChange={(e) => {
                setResolution(e.target.value as Resolution);
              }}
            >
              <option value="480p">480p</option>
              <option value="720p">{t('clips.default')}</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <ModelSelect
            models={props.models ?? []}
            value={modelKey}
            disabled={busy}
            onChange={setModelKey}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busy || (estimate !== null && planned.length === 0)}
            onClick={() => void start({})}
          >
            <Icon name="generate" /> {t('clips.generate')}
            {estimate ? buttonPrice : ` · ${t('clips.pricing')}`}
          </button>
          <CancelActiveRuns jobs={videos.scenes.map((s) => s.activeJob)} video />
        </div>
      )}
      {estimate && planned.length > 0 && (
        <details className="brief-box" aria-label={t('clips.estimateLabel')}>
          <summary className="small-text">
            {t('clips.summary', {
              model: estimate.modelKey,
              resolution: estimate.resolution,
              count: planned.length,
            })}{' '}
            ·{' '}
            {estimate.unknownCost
              ? t('clips.costUnknown')
              : t('clips.costEstimated', { amount: formatUsd(estimate.totalEstimatedUsd ?? '0') })}
            {estimate.requestBudgetUsd !== null &&
              ` ${t('clips.budgetPerRequest', { amount: formatUsd(estimate.requestBudgetUsd) })}`}
          </summary>
          <ul className="plain-list small-text">
            {estimate.scenes.map((s) => (
              <li key={s.sceneId}>
                {t('clips.sceneLine', {
                  number: s.sceneNumber,
                  action: t(`clips.action.${s.action}`),
                })}
                {s.action === 'generate' && s.billedSeconds !== null
                  ? ` ${t('clips.billed', { scene: s.sceneSeconds, billed: s.billedSeconds })}${
                      s.requestedSeconds !== null && s.billedSeconds > s.requestedSeconds
                        ? ` ${t('clips.minimum', { requested: s.requestedSeconds })}`
                        : ''
                    }${
                      s.estimatedUsd === null
                        ? ` ${t('clips.priceUnknown')}`
                        : ` · ${formatUsd(s.estimatedUsd)}`
                    }`
                  : ''}
              </li>
            ))}
          </ul>
          {estimate.providerRetainsInputs && (
            <p className="muted small-text">{t('clips.retains')}</p>
          )}
        </details>
      )}
      {pending && (
        <CostConfirmDialog
          open
          title={t('clips.confirmTitle', { count: toGenerate(pending.plan).length })}
          description={`${pending.plan.modelKey} · ${pending.plan.resolution}`}
          lines={toGenerate(pending.plan).map((s) => ({
            label: t('clips.scene', { number: s.sceneNumber }),
            usd: s.estimatedUsd,
          }))}
          totalUsd={pending.plan.totalEstimatedUsd}
          unknown={pending.plan.unknownCost}
          thresholdUsd={threshold}
          reasons={pending.reasons}
          action={t('clips.confirmAction')}
          busy={busy}
          onCancel={() => {
            setPending(null);
          }}
          onConfirm={() => void generate(pending.plan, pending.scope)}
        />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="scene-grid">
        {videos.scenes
          .filter((scene) => !props.onlySceneId || scene.sceneId === props.onlySceneId)
          .map((scene) => (
            <article
              key={scene.sceneId}
              className="scene-images"
              aria-label={t('clips.sceneTitle', { number: scene.sceneNumber })}
            >
              <div className="section-head">
                <div>
                  <h3>
                    {t('clips.scene', { number: String(scene.sceneNumber).padStart(2, '0') })}{' '}
                    {scene.clip ? (
                      <Pill tone="green">{t('clips.chosen')}</Pill>
                    ) : scene.keyframe ? (
                      <Pill tone="gray">{t('clips.noClip')}</Pill>
                    ) : (
                      <Pill tone="amber">{t('clips.noKeyframe')}</Pill>
                    )}
                  </h3>
                  <p>
                    {scene.videoPrompt} · {String(scene.durationSeconds)} s
                  </p>
                  <JobLine
                    job={scene.activeJob ?? scene.lastJob}
                    progress={scene.progress}
                    canEdit={canEdit}
                    busy={busy}
                    onRecheck={(id) => void act(`/generation-jobs/${id}/recheck`)}
                  />
                </div>
                {canEdit && scene.keyframe && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy || scene.activeJob !== null}
                    onClick={() => void start({ sceneIds: [scene.sceneId], regenerate: true })}
                  >
                    {t('clips.regenerate', { number: scene.sceneNumber })}
                  </button>
                )}
              </div>
              {scene.candidates.length === 0 ? (
                <p className="muted small-text">{t('clips.none')}</p>
              ) : (
                <ul
                  className="candidate-grid"
                  aria-label={t('clips.candidates', { number: scene.sceneNumber })}
                >
                  {scene.candidates.map((asset, i) => (
                    <ClipCandidate
                      key={asset.id}
                      asset={asset}
                      label={t('clips.candidate', { number: scene.sceneNumber, index: i + 1 })}
                      index={i + 1}
                      selected={scene.clip?.id === asset.id}
                      canEdit={canEdit}
                      busy={busy}
                      sceneId={scene.sceneId}
                      onAction={(path, method, body) => void act(path, method, body)}
                    />
                  ))}
                </ul>
              )}
            </article>
          ))}
      </div>
    </div>
  );
}

function JobLine(props: {
  readonly job: GenerationJobDto | null;
  readonly progress: StoryboardVideosDto['scenes'][number]['progress'];
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onRecheck: (jobId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { job, progress } = props;
  if (!job) return null;
  const running = job.status === 'running' && progress?.providerStatus !== null;
  return (
    // A div, not a p: the delivered-output preview opens a dialog with block content.
    <div role="status" className="job-line">
      {t('clips.job', { status: t(`state.${job.status}`) })}
      {job.status === 'running' && progress
        ? progress.providerStatus
          ? ` ${t('clips.provider', { status: progress.providerStatus, count: progress.pollCount })}`
          : ` ${t('clips.submitting')}`
        : ''}
      {job.errorCode ? ` — ${jobErrorText(job.errorCode, locale)}` : ''}
      <JobErrorDetail job={job} /> <DeliveredOutputActions job={job} canEdit={props.canEdit} />
      {props.canEdit && running && (
        <>
          {' '}
          <button
            type="button"
            className="btn small"
            disabled={props.busy}
            onClick={() => {
              props.onRecheck(job.id);
            }}
          >
            {t('clips.checkAgain')}
          </button>
        </>
      )}
    </div>
  );
}

function ClipCandidate(props: {
  readonly asset: AssetDto;
  readonly label: string;
  readonly index: number;
  readonly selected: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly sceneId: string;
  readonly onAction: (path: string, method?: 'POST' | 'PUT', body?: unknown) => void;
}) {
  const t = useT();
  const { asset } = props;
  return (
    <li aria-label={props.label} className={props.selected ? 'candidate selected' : 'candidate'}>
      <div className="candidate-image">
        {/* Range-streamed through the same-origin API (M5a); never a storage URL. */}
        <video
          src={assetContentUrl(asset.id)}
          controls
          preload="metadata"
          playsInline
          aria-label={t('clips.play', { label: props.label })}
        />
        {props.selected && (
          <span className="selected-label">
            <Icon name="check" size={14} /> {t('clips.clip')}
          </span>
        )}
      </div>
      <div className="candidate-foot">
        <div className="row">
          <b>{t('clips.clipN', { index: props.index })}</b>
          <span>
            {asset.durationMs ? formatSeconds(asset.durationMs) : ''}
            {asset.width && asset.height ? ` · ${String(asset.width)}×${String(asset.height)}` : ''}
          </span>
        </div>
        <div className="row">
          <ApprovalPill status={asset.approvalStatus} />
        </div>
        {props.canEdit && (
          <div className="row">
            {asset.approvalStatus !== 'approved' && (
              <button
                type="button"
                className="btn small"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(`/assets/${asset.id}/approve`);
                }}
              >
                {t('clips.approve')}
              </button>
            )}
            {asset.approvalStatus !== 'rejected' && !props.selected && (
              <button
                type="button"
                className="btn small danger"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(`/assets/${asset.id}/reject`);
                }}
              >
                {t('clips.reject')}
              </button>
            )}
            {asset.approvalStatus === 'approved' && !props.selected && (
              <button
                type="button"
                className="btn small primary"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(`/scenes/${props.sceneId}/clip`, 'PUT', { assetId: asset.id });
                }}
              >
                {t('clips.use')}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
