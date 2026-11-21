'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  AssetDto,
  GenerationJobDto,
  StoryboardVideosDto,
  VideoEstimateDto,
  VideoGenerateResponseDto,
} from '@acf/contracts';

import { CancelActiveRuns } from '@/components/cancel-run';
import { ModelSelect, type ModelOption } from '@/components/model-select';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { DeliveredOutputActions } from '@/components/delivered-output';
import { formatSeconds, jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

type Resolution = VideoEstimateDto['resolution'];

const ACTION_LABEL: Readonly<Record<VideoEstimateDto['scenes'][number]['action'], string>> = {
  generate: 'generate',
  reuse_clip: 'reuse an identical clip',
  skip_has_clip: 'has a clip',
  skip_existing_result: 'already generated',
  skip_in_progress: 'in progress',
  skip_no_keyframe: 'needs a keyframe',
  skip_exceeds_model_maximum: 'longer than the model allows',
};

/**
 * Scene clips (M5 design §6, §12): estimate with billed seconds, generate only after the
 * estimate was shown (the API checks the confirmed total and the spend guard), follow provider
 * progress, review candidates and choose each scene's clip (gate 4).
 */
export function SceneClipsPanel(props: {
  readonly videos: StoryboardVideosDto;
  readonly canEdit: boolean;
  /** Enabled video models the editor may pick instead of the task route. */
  readonly models?: readonly ModelOption[];
}) {
  const router = useRouter();
  const { videos, canEdit } = props;
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [modelKey, setModelKey] = useState('');
  const model = modelKey ? { modelKey } : {};
  const [estimate, setEstimate] = useState<VideoEstimateDto | null>(null);
  /** The scene selection the shown estimate was made for; generate sends the same. */
  const [scope, setScope] = useState<Record<string, unknown>>({});
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withClip = videos.scenes.filter((s) => s.clip !== null).length;

  async function run<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await mutate<T>(method, path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return null;
    }
    return r.data;
  }

  async function estimateCost(extra: Record<string, unknown> = {}) {
    const plan = await run<VideoEstimateDto>(
      'POST',
      `/storyboards/${videos.storyboardVersionId}/videos/estimate`,
      { resolution, ...model, ...extra },
    );
    if (plan) {
      setEstimate(plan);
      setScope(extra);
    }
  }

  async function generate() {
    if (!estimate) return;
    const result = await run<VideoGenerateResponseDto>(
      'POST',
      `/storyboards/${videos.storyboardVersionId}/videos/generate`,
      {
        resolution,
        ...model,
        ...scope,
        confirmedEstimateUsd: estimate.totalEstimatedUsd,
        ...(acceptUnknown ? { acceptUnknownCost: true } : {}),
      },
    );
    setEstimate(result?.estimate ?? null);
    if (result) {
      toast(
        result.jobs.length > 0
          ? `${String(result.jobs.length)} clip job(s) queued.`
          : 'Nothing to generate: every scene has a clip, a running job or no keyframe.',
      );
      router.refresh();
    }
  }

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    if ((await run(method, path, body)) !== null) router.refresh();
  }

  const toGenerate = estimate?.scenes.filter((s) => s.action === 'generate') ?? [];
  const overRequestBudget =
    estimate !== null &&
    estimate.totalEstimatedUsd !== null &&
    estimate.requestBudgetUsd !== null &&
    Number(estimate.totalEstimatedUsd) > Number(estimate.requestBudgetUsd);

  return (
    <div aria-label="Scene clip controls">
      <div className="section-head">
        <div>
          <h2>Scene clips</h2>
          <p>Animate each approved keyframe, review the clips and choose one per scene.</p>
        </div>
        <span
          className={videos.clipsComplete ? 'status green' : 'status gray'}
          aria-label="Clip gate"
        >
          {videos.clipsComplete
            ? 'All scenes have a clip'
            : `${String(withClip)} of ${String(videos.scenes.length)} scenes have a clip`}
        </span>
      </div>
      {!videos.keyframesComplete && (
        <p className="notice" role="status">
          Scenes without a keyframe are skipped. Choose keyframes first.
        </p>
      )}
      {canEdit && (
        <div className="image-toolbar">
          <label className="field">
            Resolution
            <select
              value={resolution}
              onChange={(e) => {
                setResolution(e.target.value as Resolution);
                setEstimate(null);
              }}
            >
              <option value="480p">480p</option>
              <option value="720p">720p (default)</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <ModelSelect
            models={props.models ?? []}
            value={modelKey}
            disabled={busy}
            onChange={(key) => {
              setModelKey(key);
              setEstimate(null);
            }}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void estimateCost()}>
            Estimate cost
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !estimate || toGenerate.length === 0 || overRequestBudget}
            title={estimate ? undefined : 'Estimate the cost first'}
            onClick={() => void generate()}
          >
            <span aria-hidden="true">▶</span> Generate clips
          </button>
          <CancelActiveRuns jobs={videos.scenes.map((s) => s.activeJob)} video />
        </div>
      )}
      {estimate && (
        <div className="brief-box" role="status" aria-label="Clip estimate">
          <p className="small-text">
            {estimate.modelKey} · {estimate.resolution} · {toGenerate.length} scene(s) to generate ·{' '}
            {estimate.unknownCost
              ? 'cost unknown (not priced for these settings)'
              : `estimated ${formatUsd(estimate.totalEstimatedUsd ?? '0')}`}{' '}
            {estimate.requestBudgetUsd !== null &&
              ` · budget ${formatUsd(estimate.requestBudgetUsd)} per request`}
          </p>
          <ul className="plain-list small-text">
            {estimate.scenes.map((s) => (
              <li key={s.sceneId}>
                Scene {s.sceneNumber}: {ACTION_LABEL[s.action]}
                {s.action === 'generate' && s.billedSeconds !== null
                  ? ` · ${String(s.sceneSeconds)} s scene billed as ${String(s.billedSeconds)} s${
                      s.requestedSeconds !== null && s.billedSeconds > s.requestedSeconds
                        ? ` (${String(s.requestedSeconds)} s clip; model minimum)`
                        : ''
                    }${
                      s.estimatedUsd === null
                        ? ' (price unknown)'
                        : ` · ${formatUsd(s.estimatedUsd)}`
                    }`
                  : ''}
              </li>
            ))}
          </ul>
          {estimate.providerRetainsInputs && (
            <p className="muted small-text">
              The video provider keeps prompts and keyframes (no zero-data-retention for video).
              Generation runs at the provider for minutes; canceling stops following it but it may
              still be charged.
            </p>
          )}
          {overRequestBudget && (
            <p className="form-error" role="alert">
              Above the per-request budget: generate fewer scenes at a time, or ask a project owner
              to raise the budget.
            </p>
          )}
        </div>
      )}
      {canEdit && estimate?.unknownCost && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={acceptUnknown}
            onChange={(e) => {
              setAcceptUnknown(e.target.checked);
            }}
          />
          I accept that the cost is unknown until the clips are generated
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {videos.scenes.map((scene) => (
        <article
          key={scene.sceneId}
          className="scene-images"
          aria-label={`Scene ${String(scene.sceneNumber)} clips`}
        >
          <div className="section-head">
            <div>
              <h3>
                Scene {String(scene.sceneNumber).padStart(2, '0')}{' '}
                {scene.clip ? (
                  <Pill tone="green">Clip chosen</Pill>
                ) : scene.keyframe ? (
                  <Pill tone="gray">No clip</Pill>
                ) : (
                  <Pill tone="amber">No keyframe</Pill>
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
                onClick={() =>
                  void estimateCost({ sceneIds: [scene.sceneId], regenerate: true }).then(() => {
                    toast(
                      `Review the estimate for scene ${String(scene.sceneNumber)}, then generate.`,
                    );
                  })
                }
              >
                Regenerate scene {scene.sceneNumber}
              </button>
            )}
          </div>
          {scene.candidates.length === 0 ? (
            <p className="muted small-text">No clips yet.</p>
          ) : (
            <ul
              className="candidate-grid"
              aria-label={`Scene ${String(scene.sceneNumber)} clip candidates`}
            >
              {scene.candidates.map((asset, i) => (
                <ClipCandidate
                  key={asset.id}
                  asset={asset}
                  label={`Scene ${String(scene.sceneNumber)} clip ${String(i + 1)}`}
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
  );
}

function JobLine(props: {
  readonly job: GenerationJobDto | null;
  readonly progress: StoryboardVideosDto['scenes'][number]['progress'];
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onRecheck: (jobId: string) => void;
}) {
  const { job, progress } = props;
  if (!job) return null;
  const running = job.status === 'running' && progress?.providerStatus !== null;
  return (
    <p role="status">
      Clip job {job.status}
      {job.status === 'running' && progress
        ? progress.providerStatus
          ? ` · provider: ${progress.providerStatus} · ${String(progress.pollCount)} check(s)`
          : ' · submitting'
        : ''}
      {job.errorCode ? ` — ${jobErrorText(job.errorCode)}` : ''}{' '}
      <DeliveredOutputActions job={job} canEdit={props.canEdit} />
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
            Check again
          </button>
        </>
      )}
    </p>
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
          aria-label={`Play ${props.label}`}
        />
        {props.selected && <span className="selected-label">✓ Clip</span>}
      </div>
      <div className="candidate-foot">
        <div className="row">
          <b>Clip {props.index}</b>
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
                Approve
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
                Reject
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
                Use as clip
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
