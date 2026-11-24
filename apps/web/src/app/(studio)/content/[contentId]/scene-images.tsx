'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type {
  AssetDto,
  ImageEstimateDto,
  ImageGenerateResponseDto,
  StoryboardImagesDto,
} from '@acf/contracts';

import { CancelActiveRuns } from '@/components/cancel-run';
import { CostConfirmDialog, estimateText } from '@/components/cost-confirm';
import { useLocale, useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { ModelSelect, type ModelOption } from '@/components/model-select';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { confirmReasons, type ConfirmReason } from '@/lib/cost-confirm';
import { jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

type Scope = Readonly<Record<string, unknown>>;

/**
 * Scene images of the approved storyboard (M4 design §8; redesign R-D4): the price is on the
 * button, a click within the cost threshold generates at once (one job per scene), above it or
 * with an unknown price it asks first; review candidates, choose each scene's keyframe (gate 3).
 */
export function SceneImagesPanel(props: {
  readonly images: StoryboardImagesDto;
  readonly canEdit: boolean;
  /** Show only this scene (the Scenes board's selected row); null shows every scene. */
  readonly onlySceneId?: string | null;
  /** Enabled image models the editor may pick instead of the task route. */
  readonly models?: readonly ModelOption[];
  /** R-D4: the effective cost-confirmation threshold (USD). */
  readonly confirmThresholdUsd?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { images, canEdit } = props;
  const threshold = props.confirmThresholdUsd ?? '1';
  const [count, setCount] = useState(1);
  const [modelKey, setModelKey] = useState('');
  const [estimate, setEstimate] = useState<ImageEstimateDto | null>(null);
  const [pending, setPending] = useState<{
    plan: ImageEstimateDto;
    scope: Scope;
    reasons: ConfirmReason[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [priced, setPriced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withKeyframe = images.scenes.filter((s) => s.keyframe !== null).length;
  const complete = withKeyframe === images.scenes.length;

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
    async (scope: Scope): Promise<ImageEstimateDto | null> => {
      const r = await mutate<ImageEstimateDto>(
        'POST',
        `/storyboards/${images.storyboardVersionId}/images/estimate`,
        { count, ...(modelKey ? { modelKey } : {}), ...scope },
      );
      return r.ok ? r.data : null;
    },
    [images.storyboardVersionId, count, modelKey],
  );

  const shape = images.scenes
    .map((s) => `${s.keyframe?.id ?? ''}:${s.activeJob?.id ?? ''}:${String(s.candidates.length)}`)
    .join(',');
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    void estimateFor({}).then((plan) => {
      if (!live) return;
      setEstimate(plan);
      // Without an estimate the button still works: a click estimates again and shows why.
      setPriced(true);
    });
    return () => {
      live = false;
    };
  }, [canEdit, estimateFor, shape]);

  const toGenerate = (plan: ImageEstimateDto | null) =>
    plan?.scenes.filter((s) => s.action === 'generate') ?? [];

  async function generate(plan: ImageEstimateDto, scope: Scope) {
    setPending(null);
    const result = await run<ImageGenerateResponseDto>(
      'POST',
      `/storyboards/${images.storyboardVersionId}/images/generate`,
      {
        count,
        ...(modelKey ? { modelKey } : {}),
        ...(plan.unknownCost ? { acceptUnknownCost: true } : {}),
        ...scope,
      },
    );
    if (result) {
      setEstimate(result.estimate);
      toast(
        result.jobs.length > 0 ? t('img.queued', { count: result.jobs.length }) : t('img.nothing'),
      );
      router.refresh();
    }
  }

  async function start(scope: Scope) {
    setBusy(true);
    setError(null);
    const plan = await estimateFor(scope);
    setBusy(false);
    if (!plan) {
      setError(t('form.requestFailed', { status: 0 }));
      return;
    }
    if (toGenerate(plan).length === 0) {
      toast(t('img.nothing'));
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
  return (
    <div aria-label={t('img.controls')}>
      <div className="section-head">
        <div>
          <h2>{t('img.title')}</h2>
          <p>{t('img.hint')}</p>
        </div>
        <span className={complete ? 'status green' : 'status gray'} aria-label={t('img.gate')}>
          {complete
            ? t('img.complete')
            : t('img.count', { done: withKeyframe, total: images.scenes.length })}
        </span>
      </div>
      {canEdit && (
        <div className="image-toolbar">
          <label className="field">
            {t('img.perScene')}
            <select
              value={count}
              onChange={(e) => {
                setCount(Number(e.target.value));
              }}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
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
            <Icon name="generate" /> {t('img.generate')}
            {estimate
              ? planned.length > 0
                ? ` · ${estimateText(estimate.totalEstimatedUsd, estimate.unknownCost)}`
                : ''
              : priced
                ? ''
                : ` · ${t('clips.pricing')}`}
          </button>
          <CancelActiveRuns jobs={images.scenes.map((s) => s.activeJob)} />
        </div>
      )}
      {estimate && planned.length > 0 && (
        <p className="muted small-text" role="status" aria-label={t('img.estimateLabel')}>
          {t('img.summary', {
            model: estimate.modelKey,
            resolution: estimate.resolution ? ` · ${estimate.resolution}` : '',
            count: planned.length,
          })}{' '}
          ·{' '}
          {estimate.unknownCost
            ? t('img.costUnknown')
            : t('clips.costEstimated', { amount: formatUsd(estimate.totalEstimatedUsd ?? '0') })}
        </p>
      )}
      {pending && (
        <CostConfirmDialog
          open
          title={t('img.confirmTitle', { count: toGenerate(pending.plan).length })}
          description={pending.plan.modelKey}
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
        {images.scenes
          .filter((scene) => !props.onlySceneId || scene.sceneId === props.onlySceneId)
          .map((scene) => {
            const job = scene.activeJob ?? scene.lastJob;
            return (
              <article
                key={scene.sceneId}
                className="scene-images"
                aria-label={t('img.sceneTitle', { number: scene.sceneNumber })}
              >
                <div className="section-head">
                  <div>
                    <h3>
                      {t('clips.scene', { number: String(scene.sceneNumber).padStart(2, '0') })}{' '}
                      {scene.keyframe ? (
                        <Pill tone="green">{t('img.chosen')}</Pill>
                      ) : (
                        <Pill tone="gray">{t('img.noKeyframe')}</Pill>
                      )}
                    </h3>
                    <p>{scene.imagePrompt}</p>
                    {job && (
                      <p role="status">
                        {t('img.job', { status: t(`state.${job.status}`) })}
                        {job.attempt > 1 ? ` ${t('pc.attempt', { count: job.attempt })}` : ''}
                        {job.errorCode ? ` — ${jobErrorText(job.errorCode, locale)}` : ''}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy || scene.activeJob !== null}
                      onClick={() => void start({ sceneIds: [scene.sceneId], regenerate: true })}
                    >
                      {t('img.regenerate', { number: scene.sceneNumber })}
                    </button>
                  )}
                </div>
                {scene.candidates.length === 0 ? (
                  <p className="muted small-text">{t('img.none')}</p>
                ) : (
                  <ul
                    className="candidate-grid"
                    aria-label={t('img.candidates', { number: scene.sceneNumber })}
                  >
                    {scene.candidates.map((asset, i) => (
                      <Candidate
                        key={asset.id}
                        asset={asset}
                        index={i + 1}
                        label={t('img.candidate', { number: scene.sceneNumber, index: i + 1 })}
                        isKeyframe={scene.keyframe?.id === asset.id}
                        canEdit={canEdit}
                        busy={busy}
                        onAction={(path, method, body) => void act(path, method, body)}
                        sceneId={scene.sceneId}
                      />
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
      </div>
    </div>
  );
}

function Candidate(props: {
  readonly asset: AssetDto;
  readonly index: number;
  readonly label: string;
  readonly isKeyframe: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly sceneId: string;
  readonly onAction: (path: string, method?: 'POST' | 'PUT', body?: unknown) => void;
}) {
  const t = useT();
  const { asset } = props;
  return (
    <li aria-label={props.label} className={props.isKeyframe ? 'candidate selected' : 'candidate'}>
      <div className="candidate-image">
        {/* Streamed through the same-origin API; never a storage URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API stream, not a static asset */}
        <img
          src={assetContentUrl(asset.id)}
          alt={props.label}
          width={asset.width ?? undefined}
          height={asset.height ?? undefined}
          loading="lazy"
        />
        {props.isKeyframe && (
          <span className="selected-label">
            <Icon name="check" size={14} /> {t('img.keyframe')}
          </span>
        )}
      </div>
      <div className="candidate-foot">
        <div className="row">
          <b>{t('img.candidateN', { index: props.index })}</b>
          <span>
            {asset.width && asset.height
              ? `${String(asset.width)}×${String(asset.height)}`
              : t('img.sizeUnknown')}
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
            {asset.approvalStatus !== 'rejected' && !props.isKeyframe && (
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
            {asset.approvalStatus === 'approved' && !props.isKeyframe && (
              <button
                type="button"
                className="btn small primary"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(`/scenes/${props.sceneId}/keyframe`, 'PUT', {
                    assetId: asset.id,
                  });
                }}
              >
                {t('img.use')}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Copies the master's current brief into this variant (R0). */
export function ResyncBriefButton({ contentId }: { readonly contentId: string }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn small"
        onClick={() =>
          void mutate('POST', `/content/${contentId}/brief/resync`).then((r) => {
            if (r.ok) {
              toast(t('img.resynced'));
              router.refresh();
            } else setError(r.message ?? t('form.requestFailed', { status: r.status }));
          })
        }
      >
        {t('img.resync')}
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
