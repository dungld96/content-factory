'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  AssetDto,
  ImageEstimateDto,
  ImageGenerateResponseDto,
  StoryboardImagesDto,
} from '@acf/contracts';

import { CancelActiveRuns } from '@/components/cancel-run';
import { ModelSelect, type ModelOption } from '@/components/model-select';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

/**
 * Scene images of the approved storyboard (M4 design §8): estimate and generate (one job per
 * scene, the worker makes the calls), review candidates, choose each scene's keyframe (gate 3).
 */
export function SceneImagesPanel(props: {
  readonly images: StoryboardImagesDto;
  readonly canEdit: boolean;
  /** Enabled image models the editor may pick instead of the task route. */
  readonly models?: readonly ModelOption[];
}) {
  const router = useRouter();
  const { images, canEdit } = props;
  const [count, setCount] = useState(1);
  const [modelKey, setModelKey] = useState('');
  const model = modelKey ? { modelKey } : {};
  const [estimate, setEstimate] = useState<ImageEstimateDto | null>(null);
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withKeyframe = images.scenes.filter((s) => s.keyframe !== null).length;
  const complete = withKeyframe === images.scenes.length;

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

  async function estimateCost() {
    const plan = await run<ImageEstimateDto>(
      'POST',
      `/storyboards/${images.storyboardVersionId}/images/estimate`,
      { count, ...model },
    );
    if (plan) setEstimate(plan);
  }

  async function generate(extra: Record<string, unknown> = {}) {
    const result = await run<ImageGenerateResponseDto>(
      'POST',
      `/storyboards/${images.storyboardVersionId}/images/generate`,
      { count, ...model, ...(acceptUnknown ? { acceptUnknownCost: true } : {}), ...extra },
    );
    if (result) {
      setEstimate(result.estimate);
      toast(
        result.jobs.length > 0
          ? `${String(result.jobs.length)} image job(s) queued.`
          : 'Nothing to generate: every scene already has images or a keyframe.',
      );
      router.refresh();
    }
  }

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    if ((await run(method, path, body)) !== null) router.refresh();
  }

  return (
    <div aria-label="Scene image controls">
      <div className="section-head">
        <div>
          <h2>Scene keyframes</h2>
          <p>Generate candidates, compare them and choose one approved image per scene.</p>
        </div>
        <span className={complete ? 'status green' : 'status gray'} aria-label="Keyframe gate">
          {complete
            ? 'All scenes have a keyframe'
            : `${String(withKeyframe)} of ${String(images.scenes.length)} scenes have a keyframe`}
        </span>
      </div>
      {canEdit && (
        <div className="image-toolbar">
          <label className="field">
            Candidates per scene
            <select
              value={count}
              onChange={(e) => {
                setCount(Number(e.target.value));
                setEstimate(null);
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
            disabled={busy}
            onClick={() => void generate()}
          >
            <span aria-hidden="true">✧</span> Generate images
          </button>
          <CancelActiveRuns jobs={images.scenes.map((s) => s.activeJob)} />
        </div>
      )}
      {estimate && (
        <p className="muted small-text" role="status" aria-label="Image estimate">
          {estimate.modelKey}
          {estimate.resolution ? ` · ${estimate.resolution}` : ''} ·{' '}
          {estimate.scenes.filter((s) => s.action === 'generate').length} scene(s) to generate ·{' '}
          {estimate.unknownCost
            ? 'cost unknown (priced per token or not priced)'
            : `estimated ${estimate.totalEstimatedUsd ?? '?'} USD`}
          {!estimate.unknownCost && estimate.totalEstimatedUsd
            ? ` (${formatUsd(estimate.totalEstimatedUsd)})`
            : ''}
        </p>
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
          I accept that the cost is unknown until the images are generated
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {images.scenes.map((scene) => {
        const job = scene.activeJob ?? scene.lastJob;
        return (
          <article
            key={scene.sceneId}
            className="scene-images"
            aria-label={`Scene ${String(scene.sceneNumber)} images`}
          >
            <div className="section-head">
              <div>
                <h3>
                  Scene {String(scene.sceneNumber).padStart(2, '0')}{' '}
                  {scene.keyframe ? (
                    <Pill tone="green">Keyframe chosen</Pill>
                  ) : (
                    <Pill tone="gray">No keyframe</Pill>
                  )}
                </h3>
                <p>{scene.imagePrompt}</p>
                {job && (
                  <p role="status">
                    Image job {job.status}
                    {job.attempt > 1 ? ` (attempt ${String(job.attempt)})` : ''}
                    {job.errorCode ? ` — ${jobErrorText(job.errorCode)}` : ''}
                  </p>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="btn small"
                  disabled={busy || scene.activeJob !== null}
                  onClick={() => void generate({ sceneIds: [scene.sceneId], regenerate: true })}
                >
                  Regenerate scene {scene.sceneNumber}
                </button>
              )}
            </div>
            {scene.candidates.length === 0 ? (
              <p className="muted small-text">No images yet.</p>
            ) : (
              <ul
                className="candidate-grid"
                aria-label={`Scene ${String(scene.sceneNumber)} candidates`}
              >
                {scene.candidates.map((asset, i) => (
                  <Candidate
                    key={asset.id}
                    asset={asset}
                    index={i + 1}
                    label={`Scene ${String(scene.sceneNumber)} candidate ${String(i + 1)}`}
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
        {props.isKeyframe && <span className="selected-label">✓ Keyframe</span>}
      </div>
      <div className="candidate-foot">
        <div className="row">
          <b>Candidate {props.index}</b>
          <span>
            {asset.width && asset.height
              ? `${String(asset.width)}×${String(asset.height)}`
              : 'size unknown'}
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
            {asset.approvalStatus !== 'rejected' && !props.isKeyframe && (
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
                Use as keyframe
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
              toast('Brief resynced from the master.');
              router.refresh();
            } else setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
          })
        }
      >
        Resync brief from master
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
