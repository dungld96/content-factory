'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  AssetDto,
  StoryboardVoiceoversDto,
  VoiceoverEstimateDto,
  VoiceoverGenerateResponseDto,
  VoiceProfileDto,
} from '@acf/contracts';

import { Icon } from '@/components/icon';
import { CancelActiveRuns } from '@/components/cancel-run';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { DeliveredOutputActions, JobErrorDetail } from '@/components/delivered-output';
import { formatSeconds, jobErrorText } from '@/lib/format';
import { formatUsd } from '@/lib/money';

const ACTION_LABEL: Readonly<Record<VoiceoverEstimateDto['scenes'][number]['action'], string>> = {
  generate: 'generate',
  reuse_voiceover: 'reuse an identical voice-over',
  skip_has_voiceover: 'has a voice-over',
  skip_existing_result: 'already generated',
  skip_in_progress: 'in progress',
  skip_no_text: 'no voice-over text',
};

/**
 * Scene voice-overs (M5 design §7, §12): the content item's voice profile, estimate and
 * generate per scene, review generated and imported audio, choose one per scene.
 */
export function SceneVoiceoversPanel(props: {
  readonly contentId: string;
  readonly voiceovers: StoryboardVoiceoversDto;
  readonly profiles: readonly VoiceProfileDto[];
  readonly canEdit: boolean;
  /** Show only this scene (the Scenes board's selected row); null shows every scene. */
  readonly onlySceneId?: string | null;
}) {
  const router = useRouter();
  const { voiceovers, profiles, canEdit } = props;
  const [estimate, setEstimate] = useState<VoiceoverEstimateDto | null>(null);
  const [acceptUnknown, setAcceptUnknown] = useState(false);
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
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
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

  async function estimateCost() {
    const plan = await run<VoiceoverEstimateDto>(
      'POST',
      `/storyboards/${voiceovers.storyboardVersionId}/voiceovers/estimate`,
      {},
    );
    if (plan) setEstimate(plan);
  }

  async function generate(extra: Record<string, unknown> = {}) {
    const result = await run<VoiceoverGenerateResponseDto>(
      'POST',
      `/storyboards/${voiceovers.storyboardVersionId}/voiceovers/generate`,
      { ...(acceptUnknown ? { acceptUnknownCost: true } : {}), ...extra },
    );
    if (result) {
      setEstimate(result.estimate);
      toast(
        result.jobs.length > 0
          ? `${String(result.jobs.length)} voice-over job(s) queued.`
          : 'Nothing to generate: every scene with text has a voice-over.',
      );
      router.refresh();
    }
  }

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    if ((await run(method, path, body)) !== null) router.refresh();
  }

  return (
    <div aria-label="Voice-over controls">
      <div className="section-head">
        <div>
          <h2>Voice-over</h2>
          <p>Narrate each scene with the content’s voice profile, or use imported narration.</p>
        </div>
        <span
          className={voiceovers.voiceoversComplete ? 'status green' : 'status gray'}
          aria-label="Voice-over gate"
        >
          {voiceovers.voiceoversComplete
            ? 'Every scene with text has a voice-over'
            : `${String(done)} of ${String(withText.length)} scenes have a voice-over`}
        </span>
      </div>
      <div className="image-toolbar">
        <label className="field">
          Voice profile
          <select
            value={voiceovers.voiceProfileId ?? ''}
            disabled={!canEdit || busy}
            onChange={(e) => void chooseProfile(e.target.value)}
          >
            <option value="">No voice profile</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.voice} · {p.language}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy || !profile}
              onClick={() => void estimateCost()}
            >
              Estimate cost
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !profile}
              onClick={() => void generate()}
            >
              <Icon name="generate" /> Generate voice-overs
            </button>
          </>
        )}
        {canEdit && <CancelActiveRuns jobs={voiceovers.scenes.map((s) => s.activeJob)} />}
      </div>
      {profiles.length === 0 && (
        <p className="muted small-text">
          No voice profiles yet. Create one in <Link href="/settings">Settings</Link>.
        </p>
      )}
      {profile && (
        <p className="muted small-text">
          {profile.modelKey} · voice {profile.voice} · {profile.language}
          {profile.speed !== null ? ` · speed ${String(profile.speed)}` : ''}. Narration text is
          sent only to zero-data-retention endpoints.
        </p>
      )}
      {estimate && (
        <div className="brief-box" role="status" aria-label="Voice-over estimate">
          <p className="small-text">
            {estimate.modelKey} · {estimate.scenes.filter((s) => s.action === 'generate').length}{' '}
            scene(s) to generate ·{' '}
            {estimate.unknownCost
              ? 'cost unknown (priced per token or not priced)'
              : `estimated ${formatUsd(estimate.totalEstimatedUsd ?? '0')}`}
          </p>
          <ul className="plain-list small-text">
            {estimate.scenes.map((s) => (
              <li key={s.sceneId}>
                Scene {s.sceneNumber}: {ACTION_LABEL[s.action]}
                {s.action === 'generate' ? ` · ${String(s.characters)} characters` : ''}
              </li>
            ))}
          </ul>
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
          I accept that the cost is unknown until the voice-overs are generated
        </label>
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
                aria-label={`Scene ${String(scene.sceneNumber)} voice-over`}
              >
                <div className="section-head">
                  <div>
                    <h3>
                      Scene {String(scene.sceneNumber).padStart(2, '0')}{' '}
                      {scene.text === '' ? (
                        <Pill tone="gray">No text</Pill>
                      ) : scene.voiceover ? (
                        <Pill tone="green">Voice-over chosen</Pill>
                      ) : (
                        <Pill tone="gray">No voice-over</Pill>
                      )}
                      {scene.exceedsScene && <Pill tone="amber">Longer than the scene</Pill>}
                    </h3>
                    <p>
                      {scene.text || 'This scene has no voice-over text.'} ·{' '}
                      {String(scene.durationSeconds)} s
                    </p>
                    {job && (
                      <div role="status" className="job-line">
                        Voice-over job {job.status}
                        {job.attempt > 1 ? ` (attempt ${String(job.attempt)})` : ''}
                        {job.errorCode ? ` — ${jobErrorText(job.errorCode)}` : ''}
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
                      onClick={() => void generate({ sceneIds: [scene.sceneId], regenerate: true })}
                    >
                      Regenerate scene {scene.sceneNumber}
                    </button>
                  )}
                </div>
                {scene.candidates.length === 0 ? (
                  <p className="muted small-text">No voice-overs yet.</p>
                ) : (
                  <ul
                    className="audio-list"
                    aria-label={`Scene ${String(scene.sceneNumber)} voice-over candidates`}
                  >
                    {scene.candidates.map((asset, i) => (
                      <AudioCandidate
                        key={asset.id}
                        asset={asset}
                        label={`Scene ${String(scene.sceneNumber)} voice-over ${String(i + 1)}`}
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
  const { asset } = props;
  const tooLong = asset.durationMs !== null && asset.durationMs > props.sceneSeconds * 1000;
  return (
    <li aria-label={props.label} className={props.selected ? 'audio-row selected' : 'audio-row'}>
      <audio
        src={assetContentUrl(asset.id)}
        controls
        preload="metadata"
        aria-label={`Play ${props.label}`}
      />
      <span className="audio-meta">
        <b>
          {asset.sourceType === 'upload' ? (asset.originalFilename ?? 'Imported') : 'Generated'}
        </b>
        {asset.durationMs !== null && (
          <span className={tooLong ? 'unknown' : undefined}>
            {formatSeconds(asset.durationMs)}
            {tooLong ? ' (longer than the scene)' : ''}
          </span>
        )}
        <ApprovalPill status={asset.approvalStatus} />
        {props.selected && (
          <Pill tone="green">
            <Icon name="check" size={14} /> Voice-over
          </Pill>
        )}
      </span>
      {tooLong && asset.durationMs !== null && (
        <p className="form-error small-text" role="alert">
          {formatSeconds(asset.durationMs)} of narration for a {String(props.sceneSeconds)} s scene:{' '}
          {formatSeconds(asset.durationMs - props.sceneSeconds * 1000)} too long. The render will
          refuse it: shorten this scene&rsquo;s text (Storyboard → Edit scene) or use a faster voice
          profile.
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
                props.onAction(`/scenes/${props.sceneId}/voiceover`, 'PUT', {
                  assetId: asset.id,
                });
              }}
            >
              Use as voice-over
            </button>
          )}
        </span>
      )}
    </li>
  );
}
