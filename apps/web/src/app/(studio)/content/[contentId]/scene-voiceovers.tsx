'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type {
  AssetDto,
  StoryboardVoiceoversDto,
  VoiceoverEstimateDto,
  VoiceoverGenerateResponseDto,
  VoiceProfileDto,
} from '@acf/contracts';

import { CancelActiveRuns } from '@/components/cancel-run';
import { CostConfirmDialog, estimateText } from '@/components/cost-confirm';
import { DeliveredOutputActions, JobErrorDetail } from '@/components/delivered-output';
import { useLocale, useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { confirmReasons, type ConfirmReason } from '@/lib/cost-confirm';
import { formatSeconds, jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

type Scope = Readonly<Record<string, unknown>>;

/**
 * Scene voice-overs (M5 design §7, §12; redesign R-D4): the content item's voice profile, the
 * price on the button, generate at once within the cost threshold or after a confirmation,
 * review generated and imported audio, choose one per scene.
 */
export function SceneVoiceoversPanel(props: {
  readonly contentId: string;
  readonly voiceovers: StoryboardVoiceoversDto;
  readonly profiles: readonly VoiceProfileDto[];
  readonly canEdit: boolean;
  /** Show only this scene (the Scenes board's selected row); null shows every scene. */
  readonly onlySceneId?: string | null;
  /** R-D4: the effective cost-confirmation threshold (USD). */
  readonly confirmThresholdUsd?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { voiceovers, profiles, canEdit } = props;
  const threshold = props.confirmThresholdUsd ?? '1';
  const [estimate, setEstimate] = useState<VoiceoverEstimateDto | null>(null);
  const [pending, setPending] = useState<{
    plan: VoiceoverEstimateDto;
    scope: Scope;
    reasons: ConfirmReason[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withText = voiceovers.scenes.filter((s) => s.text !== '');
  const done = withText.filter((s) => s.voiceover !== null).length;
  const profile = profiles.find((p) => p.id === voiceovers.voiceProfileId);

  async function run<T>(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
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

  async function chooseProfile(id: string) {
    if (
      (await run('PATCH', `/content/${props.contentId}`, { voiceProfileId: id || null })) !== null
    ) {
      setEstimate(null);
      router.refresh();
    }
  }

  const estimateFor = useCallback(
    async (scope: Scope): Promise<VoiceoverEstimateDto | null> => {
      const r = await mutate<VoiceoverEstimateDto>(
        'POST',
        `/storyboards/${voiceovers.storyboardVersionId}/voiceovers/estimate`,
        scope,
      );
      return r.ok ? r.data : null;
    },
    [voiceovers.storyboardVersionId],
  );

  const shape = `${voiceovers.voiceProfileId ?? ''}|${voiceovers.scenes
    .map((s) => `${s.voiceover?.id ?? ''}:${s.activeJob?.id ?? ''}`)
    .join(',')}`;
  const hasProfile = profile !== undefined;
  useEffect(() => {
    if (!canEdit || !hasProfile) return;
    let live = true;
    void estimateFor({}).then((plan) => {
      if (live) setEstimate(plan);
    });
    return () => {
      live = false;
    };
  }, [canEdit, hasProfile, estimateFor, shape]);

  const toGenerate = (plan: VoiceoverEstimateDto | null) =>
    plan?.scenes.filter((s) => s.action === 'generate') ?? [];

  async function generate(plan: VoiceoverEstimateDto, scope: Scope) {
    setPending(null);
    const result = await run<VoiceoverGenerateResponseDto>(
      'POST',
      `/storyboards/${voiceovers.storyboardVersionId}/voiceovers/generate`,
      { ...(plan.unknownCost ? { acceptUnknownCost: true } : {}), ...scope },
    );
    if (result) {
      setEstimate(result.estimate);
      toast(
        result.jobs.length > 0 ? t('vo.queued', { count: result.jobs.length }) : t('vo.nothing'),
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
      toast(t('vo.nothing'));
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
    <div aria-label={t('vo.controls')}>
      <div className="section-head">
        <div>
          <h2>{t('vo.title')}</h2>
          <p>{t('vo.hint')}</p>
        </div>
        <span
          className={voiceovers.voiceoversComplete ? 'status green' : 'status gray'}
          aria-label={t('vo.gate')}
        >
          {voiceovers.voiceoversComplete
            ? t('vo.complete')
            : t('vo.count', { done, total: withText.length })}
        </span>
      </div>
      <div className="image-toolbar">
        <label className="field">
          {t('vo.profile')}
          <select
            value={voiceovers.voiceProfileId ?? ''}
            disabled={!canEdit || busy}
            onChange={(e) => void chooseProfile(e.target.value)}
          >
            <option value="">{t('vo.noProfile')}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.voice} · {p.language}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <button
            type="button"
            className="btn primary"
            disabled={busy || !profile || (estimate !== null && planned.length === 0)}
            onClick={() => void start({})}
          >
            <Icon name="generate" /> {t('vo.generate')}
            {estimate && planned.length > 0
              ? ` · ${estimateText(estimate.totalEstimatedUsd, estimate.unknownCost)}`
              : ''}
          </button>
        )}
        {canEdit && <CancelActiveRuns jobs={voiceovers.scenes.map((s) => s.activeJob)} />}
      </div>
      {profiles.length === 0 && (
        <p className="muted small-text">
          {t('vo.noProfiles')} <Link href="/settings/voices">{t('vo.settings')}</Link>.
        </p>
      )}
      {profile && (
        <p className="muted small-text">
          {t('vo.profileLine', {
            model: profile.modelKey,
            voice: profile.voice,
            language: profile.language,
            speed: profile.speed !== null ? ` ${t('vo.speed', { value: profile.speed })}` : '',
          })}
        </p>
      )}
      {estimate && planned.length > 0 && (
        <details className="brief-box" aria-label={t('vo.estimateLabel')}>
          <summary className="small-text">
            {t('vo.summary', { model: estimate.modelKey, count: planned.length })} ·{' '}
            {estimate.unknownCost
              ? t('img.costUnknown')
              : t('clips.costEstimated', { amount: formatUsd(estimate.totalEstimatedUsd ?? '0') })}
          </summary>
          <ul className="plain-list small-text">
            {estimate.scenes.map((s) => (
              <li key={s.sceneId}>
                {t('clips.sceneLine', {
                  number: s.sceneNumber,
                  action: t(`vo.action.${s.action}`),
                })}
                {s.action === 'generate' ? ` ${t('vo.characters', { count: s.characters })}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {pending && (
        <CostConfirmDialog
          open
          title={t('vo.confirmTitle', { count: toGenerate(pending.plan).length })}
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
        {voiceovers.scenes
          .filter((scene) => !props.onlySceneId || scene.sceneId === props.onlySceneId)
          .map((scene) => {
            const job = scene.activeJob ?? scene.lastJob;
            return (
              <article
                key={scene.sceneId}
                className="scene-images"
                aria-label={t('vo.sceneTitle', { number: scene.sceneNumber })}
              >
                <div className="section-head">
                  <div>
                    <h3>
                      {t('clips.scene', { number: String(scene.sceneNumber).padStart(2, '0') })}{' '}
                      {scene.text === '' ? (
                        <Pill tone="gray">{t('vo.noText')}</Pill>
                      ) : scene.voiceover ? (
                        <Pill tone="green">{t('vo.chosen')}</Pill>
                      ) : (
                        <Pill tone="gray">{t('vo.none')}</Pill>
                      )}
                      {scene.exceedsScene && <Pill tone="amber">{t('vo.tooLong')}</Pill>}
                    </h3>
                    <p>
                      {scene.text || t('vo.sceneNoText')} · {String(scene.durationSeconds)} s
                    </p>
                    {job && (
                      <div role="status" className="job-line">
                        {t('vo.job', { status: t(`state.${job.status}`) })}
                        {job.attempt > 1 ? ` ${t('pc.attempt', { count: job.attempt })}` : ''}
                        {job.errorCode ? ` — ${jobErrorText(job.errorCode, locale)}` : ''}
                        <JobErrorDetail job={job} />{' '}
                        <DeliveredOutputActions job={job} canEdit={canEdit} />
                      </div>
                    )}
                  </div>
                  {canEdit && scene.text !== '' && profile && (
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
                  <p className="muted small-text">{t('vo.noCandidates')}</p>
                ) : (
                  <ul
                    className="audio-list"
                    aria-label={t('vo.candidates', { number: scene.sceneNumber })}
                  >
                    {scene.candidates.map((asset, i) => (
                      <AudioCandidate
                        key={asset.id}
                        asset={asset}
                        label={t('vo.candidate', { number: scene.sceneNumber, index: i + 1 })}
                        sceneSeconds={scene.durationSeconds}
                        selected={scene.voiceover?.id === asset.id}
                        canEdit={canEdit}
                        busy={busy}
                        sceneId={scene.sceneId}
                        onAction={(path, method, body) => void act(path, method, body)}
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

function AudioCandidate(props: {
  readonly asset: AssetDto;
  readonly label: string;
  readonly sceneSeconds: number;
  readonly selected: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly sceneId: string;
  readonly onAction: (path: string, method?: 'POST' | 'PUT', body?: unknown) => void;
}) {
  const t = useT();
  const { asset } = props;
  const tooLong = asset.durationMs !== null && asset.durationMs > props.sceneSeconds * 1000;
  return (
    <li aria-label={props.label} className={props.selected ? 'audio-row selected' : 'audio-row'}>
      <audio
        src={assetContentUrl(asset.id)}
        controls
        preload="metadata"
        aria-label={t('clips.play', { label: props.label })}
      />
      <span className="audio-meta">
        <b>
          {asset.sourceType === 'upload'
            ? (asset.originalFilename ?? t('vo.imported'))
            : t('vo.generated')}
        </b>
        {asset.durationMs !== null && (
          <span className={tooLong ? 'unknown' : undefined}>
            {formatSeconds(asset.durationMs)}
            {tooLong ? ` ${t('vo.longer')}` : ''}
          </span>
        )}
        <ApprovalPill status={asset.approvalStatus} />
        {props.selected && (
          <Pill tone="green">
            <Icon name="check" size={14} /> {t('vo.selected')}
          </Pill>
        )}
      </span>
      {tooLong && asset.durationMs !== null && (
        <p className="form-error small-text" role="alert">
          {t('vo.tooLongText', {
            duration: formatSeconds(asset.durationMs),
            scene: props.sceneSeconds,
            over: formatSeconds(asset.durationMs - props.sceneSeconds * 1000),
          })}
        </p>
      )}
      {props.canEdit && (
        <span className="audio-actions">
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
                props.onAction(`/scenes/${props.sceneId}/voiceover`, 'PUT', {
                  assetId: asset.id,
                });
              }}
            >
              {t('vo.use')}
            </button>
          )}
        </span>
      )}
    </li>
  );
}
