'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  AssetDto,
  ImageEstimateDto,
  ImageGenerateResponseDto,
  StoryboardImagesDto,
} from '@acf/contracts';

import { assetContentUrl, mutate } from '@/lib/api-client';

const APPROVAL_BADGE: Readonly<Record<string, string>> = {
  approved: 'badge badge-ok',
  rejected: 'badge badge-err',
  pending: 'badge badge-warn',
};

/**
 * Scene images of the approved storyboard (M4 design §8): estimate and generate (one job per
 * scene, the worker makes the calls), review candidates, choose each scene's keyframe (gate 3).
 */
export function SceneImagesPanel(props: {
  readonly images: StoryboardImagesDto;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const { images, canEdit } = props;
  const [count, setCount] = useState(1);
  const [estimate, setEstimate] = useState<ImageEstimateDto | null>(null);
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withKeyframe = images.scenes.filter((s) => s.keyframe !== null).length;

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
      { count },
    );
    if (plan) setEstimate(plan);
  }

  async function generate(extra: Record<string, unknown> = {}) {
    const result = await run<ImageGenerateResponseDto>(
      'POST',
      `/storyboards/${images.storyboardVersionId}/images/generate`,
      { count, ...(acceptUnknown ? { acceptUnknownCost: true } : {}), ...extra },
    );
    if (result) {
      setEstimate(result.estimate);
      router.refresh();
    }
  }

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    if ((await run(method, path, body)) !== null) router.refresh();
  }

  return (
    <div aria-label="Scene image controls">
      <p>
        <span
          className={withKeyframe === images.scenes.length ? 'badge badge-ok' : 'badge'}
          aria-label="Keyframe gate"
        >
          {withKeyframe === images.scenes.length
            ? 'All scenes have a keyframe'
            : `${String(withKeyframe)} of ${String(images.scenes.length)} scenes have a keyframe`}
        </span>
      </p>
      {canEdit && (
        <div className="row">
          <label>
            Candidates per scene{' '}
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
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void estimateCost()}
          >
            Estimate cost
          </button>
          <button type="button" disabled={busy} onClick={() => void generate()}>
            Generate images
          </button>
        </div>
      )}
      {estimate && (
        <p className="muted" role="status" aria-label="Image estimate">
          {estimate.modelKey}
          {estimate.resolution ? ` · ${estimate.resolution}` : ''} ·{' '}
          {estimate.scenes.filter((s) => s.action === 'generate').length} scene(s) to generate ·{' '}
          {estimate.unknownCost
            ? 'cost unknown (priced per token or not priced)'
            : `estimated ${estimate.totalEstimatedUsd ?? '?'} USD`}
        </p>
      )}
      {canEdit && estimate?.unknownCost && (
        <label>
          <input
            type="checkbox"
            checked={acceptUnknown}
            onChange={(e) => {
              setAcceptUnknown(e.target.checked);
            }}
          />{' '}
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
          <article key={scene.sceneId} aria-label={`Scene ${String(scene.sceneNumber)} images`}>
            <h3>
              Scene {scene.sceneNumber}{' '}
              {scene.keyframe ? (
                <span className="badge badge-ok">Keyframe chosen</span>
              ) : (
                <span className="badge">No keyframe</span>
              )}
            </h3>
            <p className="muted">{scene.imagePrompt}</p>
            {job && (
              <p className="muted" role="status">
                Image job {job.status}
                {job.attempt > 1 ? ` (attempt ${String(job.attempt)})` : ''}
                {job.errorCode ? ` — ${job.errorCode}` : ''}
              </p>
            )}
            {scene.candidates.length === 0 ? (
              <p className="muted">No images yet.</p>
            ) : (
              <ul className="thumbs" aria-label={`Scene ${String(scene.sceneNumber)} candidates`}>
                {scene.candidates.map((asset, i) => (
                  <Candidate
                    key={asset.id}
                    asset={asset}
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
            {canEdit && (
              <button
                type="button"
                className="secondary"
                disabled={busy || scene.activeJob !== null}
                onClick={() => void generate({ sceneIds: [scene.sceneId], regenerate: true })}
              >
                Regenerate scene {scene.sceneNumber}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Candidate(props: {
  readonly asset: AssetDto;
  readonly label: string;
  readonly isKeyframe: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly sceneId: string;
  readonly onAction: (path: string, method?: 'POST' | 'PUT', body?: unknown) => void;
}) {
  const { asset } = props;
  return (
    <li aria-label={props.label}>
      {/* Streamed through the same-origin API; never a storage URL. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API stream, not a static asset */}
      <img
        src={assetContentUrl(asset.id)}
        alt={props.label}
        width={asset.width ?? undefined}
        height={asset.height ?? undefined}
        loading="lazy"
      />
      <p>
        <span className={APPROVAL_BADGE[asset.approvalStatus] ?? 'badge'}>
          {asset.approvalStatus}
        </span>
        {props.isKeyframe && <span className="badge badge-ok"> Keyframe</span>}
      </p>
      {props.canEdit && (
        <div className="row">
          {asset.approvalStatus !== 'approved' && (
            <button
              type="button"
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
              className="secondary"
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
              disabled={props.busy}
              onClick={() => {
                props.onAction(`/scenes/${props.sceneId}/keyframe`, 'PUT', { assetId: asset.id });
              }}
            >
              Use as keyframe
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Copies the master's current brief into this variant (R0). */
export function ResyncBriefButton({ contentId }: { readonly contentId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="row">
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void mutate('POST', `/content/${contentId}/brief/resync`).then((r) => {
            if (r.ok) router.refresh();
            else setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
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
    </span>
  );
}
