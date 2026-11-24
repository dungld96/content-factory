'use client';

import { useRouter } from 'next/navigation';
import { useState, type KeyboardEvent } from 'react';

import type {
  CostReportDto,
  CreateRenderResponseDto,
  RenderDto,
  RenderPlanDto,
} from '@acf/contracts';

import { CancelRunButton } from '@/components/cancel-run';
import { useLocale, useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { LocalTime } from '@/components/local-time';
import { ReviewChecklist, useChecklist } from '@/components/review/review-checklist';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { formatSeconds, jobErrorText } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { formatUsd } from '@/lib/money';
import { audioRequest, DEFAULT_AUDIO, VOICE_BLOCKERS, type AudioState } from '@/lib/render-audio';

import { RenderAudioSection } from './render-audio';

const BLOCKER_TAB: Readonly<Record<RenderPlanDto['blockers'][number]['code'], string>> = {
  STORYBOARD_NOT_APPROVED: 'storyboard',
  CLIPS_INCOMPLETE: 'clips',
  VOICEOVERS_INCOMPLETE: 'voiceover',
  VOICEOVER_EXCEEDS_SCENE: 'voiceover',
  INPUT_FILE_MISSING: 'clips',
  STORAGE_NOT_CONFIGURED: 'activity',
};

const STAGE_LABEL: Readonly<Record<string, MessageKey>> = {
  normalise: 'rp.stage.normalise',
  concat: 'rp.stage.concat',
  narration: 'rp.stage.narration',
  mix: 'rp.stage.mix',
  loudness: 'rp.stage.loudness',
  encode: 'rp.stage.encode',
};

/** What a reviewer checks by eye at the render gate (CONTENT_PIPELINE stage 10). */
const HUMAN_CHECKS: readonly MessageKey[] = [
  'check.render.identity',
  'check.render.brand',
  'check.render.facts',
  'check.render.defects',
  'check.render.voice',
  'check.render.platform',
];

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT');

/**
 * Render and export (M6 design §12): preflight, options, render, then review each render with its
 * QC report, approve (gate 5) and export the publishing package.
 */
export function RenderPanel(props: {
  readonly contentId: string;
  readonly plan: RenderPlanDto;
  readonly renders: readonly RenderDto[];
  readonly cost: CostReportDto | null;
  readonly canEdit: boolean;
  /** P4d: the content item's voice-over switch (off: the voice layer is off and locked). */
  readonly voiceEnabled?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const { plan, renders, canEdit } = props;
  const contentVoice = props.voiceEnabled ?? true;
  const [burnIn, setBurnIn] = useState(true);
  const [musicId, setMusicId] = useState('');
  const [volume, setVolume] = useState(-18);
  const [audio, setAudio] = useState<AudioState>({
    ...DEFAULT_AUDIO,
    voiceEnabled: contentVoice,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P4 S5: with the voice layer off, the voice-over blockers do not apply (the API re-checks).
  const blockers = audio.voiceEnabled
    ? plan.blockers
    : plan.blockers.filter((b) => !VOICE_BLOCKERS.has(b.code));
  const ready = blockers.length === 0 && !plan.renderInProgress;

  async function run<T>(path: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await mutate<T>('POST', path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? t('form.requestFailed', { status: r.status }));
      return null;
    }
    return r.data;
  }

  async function render(regenerate = false) {
    const result = await run<CreateRenderResponseDto>(`/content/${props.contentId}/renders`, {
      captions: { burnIn },
      ...(musicId ? { music: { assetId: musicId, volumeDb: volume } } : {}),
      ...(audioRequest(audio) ? { audio: audioRequest(audio) } : {}),
      ...(regenerate ? { regenerate: true } : {}),
    });
    if (result) {
      toast(result.reused ? t('rp.identical') : t('rp.queued'));
      router.refresh();
    }
  }

  async function act(path: string, body?: unknown, message?: string) {
    if ((await run(path, body)) !== null) {
      if (message) toast(message);
      router.refresh();
    }
  }

  return (
    <div aria-label={t('rp.controls')}>
      <div className="section-head">
        <div>
          <h2>{t('rp.title')}</h2>
          <p>{t('rp.hint')}</p>
        </div>
        <span className={ready ? 'status green' : 'status gray'} aria-label={t('rp.readiness')}>
          {plan.renderInProgress
            ? t('rp.rendering')
            : ready
              ? t('rp.ready', { scenes: plan.scenes.length, seconds: plan.totalSeconds })
              : t('rp.toFix', { count: blockers.length })}
        </span>
      </div>

      {blockers.length > 0 && (
        <ul className="plain-list" aria-label={t('rp.blockers')}>
          {blockers.map((b) => (
            <li key={`${b.code}-${String(b.sceneNumber)}`} className="form-error">
              {b.message}{' '}
              <a href={`#${BLOCKER_TAB[b.code]}`} className="small-text">
                {t('rp.fix')}
              </a>
            </li>
          ))}
        </ul>
      )}
      {plan.upscaledFrom && (
        <p className="muted small-text">{t('rp.upscaled', { from: plan.upscaledFrom })}</p>
      )}

      {canEdit && (
        <h3 className="render-step">
          <span aria-hidden="true">1</span> {t('rp.settings')}
        </h3>
      )}
      {canEdit && (
        <div className="image-toolbar">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={burnIn}
              onChange={(e) => {
                setBurnIn(e.target.checked);
              }}
            />
            {t('rp.burnIn')}
          </label>
          <label className="field">
            {t('rp.music')}
            <select
              value={musicId}
              onChange={(e) => {
                setMusicId(e.target.value);
              }}
            >
              <option value="">{t('rp.noMusic')}</option>
              {plan.musicOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.originalFilename ?? m.label ?? m.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          {musicId && (
            <label className="field">
              {t('rp.musicLevel')}
              <input
                type="number"
                min={-40}
                max={0}
                step={1}
                value={volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                }}
              />
            </label>
          )}
        </div>
      )}
      {canEdit && plan.scenes.length > 0 && (
        <RenderAudioSection
          plan={plan}
          state={audio}
          hasMusic={musicId !== ''}
          onChange={setAudio}
          voiceLocked={!contentVoice}
        />
      )}
      {canEdit && plan.musicOptions.length === 0 && (
        <p className="muted small-text">{t('rp.musicHint')}</p>
      )}
      {canEdit && (
        <>
          <h3 className="render-step">
            <span aria-hidden="true">2</span> {t('rp.render')}
          </h3>
          <div className="render-action">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !ready}
              onClick={() => void render()}
            >
              <Icon name="render" /> {t('rp.renderVideo')}
            </button>
            <span className="muted small-text">{t('rp.free')}</span>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h3 className="render-step">
        <span aria-hidden="true">{canEdit ? '3' : '1'}</span> {t('rp.review')}
      </h3>
      {renders.length === 0 ? (
        <div className="empty">{t('rp.none')}</div>
      ) : (
        renders.map((r, i) => (
          <RenderCard
            key={r.id}
            render={r}
            index={renders.length - i}
            cost={i === 0 ? props.cost : null}
            canEdit={canEdit}
            busy={busy}
            onApprove={(note) =>
              void act(`/renders/${r.id}/approve`, note ? { note } : {}, t('rp.approved'))
            }
            onReject={(note) => void act(`/renders/${r.id}/reject`, { note }, t('rp.rejected'))}
            onExport={() => void act(`/renders/${r.id}/export`, undefined, t('rp.exported'))}
          />
        ))
      )}
    </div>
  );
}

function RenderCard(props: {
  readonly render: RenderDto;
  readonly index: number;
  readonly cost: CostReportDto | null;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onApprove: (note: string) => void;
  readonly onReject: (note: string) => void;
  readonly onExport: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { render: r } = props;
  const [note, setNote] = useState('');
  const warnings = r.qc?.findings.filter((f) => f.severity === 'warning') ?? [];
  const errors = r.qc?.findings.filter((f) => f.severity === 'error') ?? [];
  const reviewable = r.status === 'succeeded' && r.reviewStatus === 'pending';
  // R-D3: the reviewer's checklist; the automated QC item is ticked when it passed.
  const items = [
    { id: 'qc', label: t('check.render.qc'), auto: r.qc !== null && errors.length === 0 },
    ...HUMAN_CHECKS.map((key) => ({ id: key, label: t(key) })),
  ];
  const checklist = useChecklist(`acf-review:render:${r.id}`, items);
  const stageKey = r.stage ? STAGE_LABEL[r.stage] : undefined;
  function onReviewKey(event: KeyboardEvent<HTMLElement>) {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      props.onApprove(note.trim());
    } else if (key === 'c') {
      event.preventDefault();
      checklist.checkAll();
    } else if (key === 'r') {
      event.preventDefault();
      document.getElementById(`render-note-${r.id}`)?.focus();
    }
  }
  return (
    <article className="scene-images" aria-label={t('rp.renderN', { index: props.index })}>
      <div className="section-head">
        <div>
          <h3>
            {t('rp.renderN', { index: props.index })}{' '}
            {r.status === 'succeeded' ? (
              r.reviewStatus === 'approved' ? (
                <Pill tone="green">
                  {r.exportedAt ? t('rp.approvedExported') : t('rp.approvedPill')}
                </Pill>
              ) : r.reviewStatus === 'rejected' ? (
                <Pill tone="red">{t('rp.rejectedPill')}</Pill>
              ) : (
                <Pill tone="amber">{t('rp.reviewRequired')}</Pill>
              )
            ) : r.status === 'failed' || r.status === 'canceled' ? (
              <Pill tone="red">{r.status === 'failed' ? t('rp.failed') : t('rp.canceled')}</Pill>
            ) : (
              <Pill tone="purple">{t('rp.renderingPill')}</Pill>
            )}
            {r.isApproved && <Pill tone="green">{t('rp.current')}</Pill>}
          </h3>
          <p>
            <LocalTime iso={r.createdAt} /> ·{' '}
            {r.burnInCaptions ? t('rp.captionsBurned') : t('rp.captionsSrt')}
            {r.musicAssetId ? ` ${t('rp.withMusic')}` : ''}
            {r.durationMs ? ` · ${formatSeconds(r.durationMs)}` : ''}
            {r.upscaledFrom ? ` ${t('rp.upscaledFrom', { from: r.upscaledFrom })}` : ''}
          </p>
          {(r.status === 'queued' || r.status === 'running') && (
            <p role="status">{stageKey ? t(stageKey) : (r.stage ?? t('rp.waiting'))}…</p>
          )}
          {props.canEdit && (r.status === 'queued' || r.status === 'running') && (
            <CancelRunButton runId={r.job.productionRunId} what={t('rp.thisRender')} />
          )}
          {r.job.errorCode && (
            <p className="form-error" role="alert">
              {jobErrorText(r.job.errorCode, locale)}
              {r.job.errorMessage ? ` (${r.job.errorMessage})` : ''}
            </p>
          )}
          {r.reviewNote && (
            <p className="muted small-text">{t('rp.reviewNote', { note: r.reviewNote })}</p>
          )}
        </div>
      </div>

      {r.video && (
        <div className="render-body">
          <video
            className="render-player"
            src={assetContentUrl(r.video.id)}
            poster={r.thumbnail ? assetContentUrl(r.thumbnail.id) : undefined}
            controls
            preload="metadata"
            playsInline
            aria-label={t('rp.play', { index: props.index })}
          />
          <div className="render-side">
            <h4>{t('rp.qc')}</h4>
            <p className="small-text">
              {errors.length === 0 ? (
                <>
                  <Icon name="check" /> {t('rp.passed')}
                </>
              ) : (
                <>
                  <Icon name="failed" /> {t('rp.qcFailed')}
                </>
              )}{' '}
              · {r.qc?.measured.width ?? '?'}×{r.qc?.measured.height ?? '?'} ·{' '}
              {r.qc?.measured.fps ?? '?'} fps · {r.qc?.measured.integratedLufs ?? '?'} LUFS
            </p>
            {warnings.length > 0 ? (
              <ul className="plain-list small-text" aria-label={t('rp.qcWarnings')}>
                {groupWarnings(t, warnings).map((g) => (
                  <li key={g.key}>
                    <Icon name="warning" /> {g.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small-text">{t('rp.noWarnings')}</p>
            )}
            {props.cost && (
              <>
                <h4>{t('rp.cost')}</h4>
                <p className="small-text" aria-label={t('rp.costSummary')}>
                  {t('rp.costLine', {
                    reported: formatUsd(props.cost.total.reportedUsd),
                    estimated: formatUsd(props.cost.total.estimatedUsd),
                    unknown:
                      props.cost.total.unknownCalls > 0
                        ? ` ${t('rp.unknownCalls', { count: props.cost.total.unknownCalls })}`
                        : '',
                    render: formatUsd(props.cost.renderCostUsd),
                  })}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {props.canEdit && reviewable && (
        <section
          className="review-panel"
          aria-label={t('review.decision')}
          tabIndex={-1}
          onKeyDown={onReviewKey}
        >
          <span className="eyebrow">{t('rp.gate')}</span>
          <ReviewChecklist items={items} state={checklist} />
          {checklist.unchecked > 0 && (
            <p className="muted small-text">
              {t('review.uncheckedHint', { count: checklist.unchecked })}
            </p>
          )}
          <label className="field">
            {t('rp.note')} <small>{t('rp.noteHint')}</small>
            <input
              id={`render-note-${r.id}`}
              value={note}
              maxLength={2000}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <div className="review-actions">
            <button
              type="button"
              className="btn primary"
              disabled={props.busy}
              aria-keyshortcuts="A"
              onClick={() => {
                props.onApprove(note.trim());
              }}
            >
              <Icon name="check" /> {t('rp.approve')}
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={props.busy || note.trim() === ''}
              onClick={() => {
                props.onReject(note.trim());
              }}
            >
              <Icon name="reject" /> {t('rp.reject')}
            </button>
          </div>
          <p className="muted small-text review-keys">{t('review.keys')}</p>
        </section>
      )}
      {props.canEdit && r.reviewStatus === 'approved' && !r.exportedAt && (
        <div className="review-actions">
          <button
            type="button"
            className="btn primary"
            disabled={props.busy}
            onClick={props.onExport}
          >
            {t('rp.export')}
          </button>
        </div>
      )}
      {r.exportedAt && (
        <ul className="plain-list small-text" aria-label={t('rp.downloads')}>
          {r.video && (
            <li>
              <a href={assetContentUrl(r.video.id)} download="video.mp4">
                video.mp4
              </a>
            </li>
          )}
          {r.subtitles && (
            <li>
              <a href={assetContentUrl(r.subtitles.id)} download="captions.srt">
                captions.srt
              </a>
            </li>
          )}
          {r.thumbnail && (
            <li>
              <a href={assetContentUrl(r.thumbnail.id)} download="thumbnail.jpg">
                thumbnail.jpg
              </a>
            </li>
          )}
          <li>
            <a href={`/api/v1/renders/${r.id}/manifest`} download="manifest.json">
              manifest.json
            </a>
          </li>
          <li>
            <a href={`/api/v1/renders/${r.id}/cost-report`} download="cost-report.json">
              cost-report.json
            </a>
          </li>
        </ul>
      )}
    </article>
  );
}

/**
 * QC warnings of one kind in one line (UX review U5): "Frozen picture in scenes 1–5" instead of
 * five identical lines. Warnings without a scene keep their own line.
 */
function groupWarnings(
  t: Translate,
  warnings: readonly {
    readonly check: string;
    readonly message: string;
    readonly scene?: number | null;
  }[],
): { key: string; text: string }[] {
  const byCheck = new Map<string, { label: string; scenes: number[] }>();
  const single: { key: string; text: string }[] = [];
  for (const w of warnings) {
    if (!w.scene) {
      single.push({ key: `${w.check}-${w.message}`, text: w.message });
      continue;
    }
    const label = w.message.replace(/\s+\d+(\.\d+)?[–-]\d+(\.\d+)?\s*s$/, '');
    const entry = byCheck.get(w.check) ?? { label, scenes: [] };
    entry.scenes.push(w.scene);
    byCheck.set(w.check, entry);
  }
  const grouped = [...byCheck].map(([check, g]) => ({
    key: check,
    text:
      g.scenes.length === 1
        ? t('rp.sceneWarn', { scene: g.scenes[0] ?? '', label: g.label })
        : t('rp.scenesWarn', {
            label: `${g.label.charAt(0).toUpperCase()}${g.label.slice(1)}`,
            scenes: g.scenes.join(', '),
          }),
  }));
  return [...grouped, ...single];
}
