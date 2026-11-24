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
import { formatBytes, formatSeconds, jobErrorText } from '@/lib/format';
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

  const [latest, ...older] = renders;
  return (
    <div className="col render-layout" aria-label={t('rp.controls')}>
      {blockers.length > 0 && (
        <ul className="callout danger col render-blockers" aria-label={t('rp.blockers')}>
          {blockers.map((b) => (
            <li key={`${b.code}-${String(b.sceneNumber)}`}>
              {b.message}{' '}
              <a href={`#${BLOCKER_TAB[b.code]}`} className="t-13">
                {t('rp.fix')}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap render-top">
        <section className="card pad col render-settings" aria-label={t('rp.settings')}>
          <div className="step-h">
            <span className={canEdit ? 'step-n' : 'step-n done'}>
              {canEdit ? '1' : <Icon name="check" size={12} />}
            </span>
            <h3>
              {canEdit ? '1 · ' : ''}
              {t('rp.settings')}
            </h3>
          </div>
          {canEdit ? (
            <>
              <label className="layer">
                <input
                  type="checkbox"
                  checked={burnIn}
                  onChange={(e) => {
                    setBurnIn(e.target.checked);
                  }}
                />
                <b className="t-13">{t('rp.burnIn')}</b>
              </label>
              <label className="layer">
                <Icon name="music" />
                <b className="t-13 layer-name">{t('rp.music')}</b>
                <select
                  className="input"
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
                <label className="layer">
                  <b className="t-13 layer-name">{t('rp.musicLevel')}</b>
                  <input
                    className="input"
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
              {plan.scenes.length > 0 && (
                <RenderAudioSection
                  plan={plan}
                  state={audio}
                  hasMusic={musicId !== ''}
                  onChange={setAudio}
                  voiceLocked={!contentVoice}
                />
              )}
              {plan.musicOptions.length === 0 && <p className="t-12 muted">{t('rp.musicHint')}</p>}
            </>
          ) : (
            <p className="t-13 muted">{t('rp.readOnly')}</p>
          )}
          <div className="step-h render-step-2">
            <span className="step-n">2</span>
            <h3>2 · {t('rp.render')}</h3>
            <span className="spacer" />
            <span
              className={ready ? 'badge success' : 'badge neutral'}
              aria-label={t('rp.readiness')}
            >
              {plan.renderInProgress
                ? t('rp.rendering')
                : ready
                  ? t('rp.ready', { scenes: plan.scenes.length, seconds: plan.totalSeconds })
                  : t('rp.toFix', { count: blockers.length })}
            </span>
          </div>
          {plan.upscaledFrom && (
            <p className="t-12 muted">{t('rp.upscaled', { from: plan.upscaledFrom })}</p>
          )}
          {canEdit && (
            <div className="row wrap">
              <button
                type="button"
                className="btn primary"
                disabled={busy || !ready}
                onClick={() => void render()}
              >
                <Icon name="render" /> {t('rp.renderVideo')}
              </button>
              <span className="t-12 muted">{t('rp.free')}</span>
            </div>
          )}
          {error && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
        </section>
        <div className="col render-review">
          {latest ? (
            <RenderCard
              render={latest}
              index={renders.length}
              cost={props.cost}
              canEdit={canEdit}
              busy={busy}
              onApprove={(note) =>
                void act(`/renders/${latest.id}/approve`, note ? { note } : {}, t('rp.approved'))
              }
              onReject={(note) =>
                void act(`/renders/${latest.id}/reject`, { note }, t('rp.rejected'))
              }
              onExport={() => void act(`/renders/${latest.id}/export`, undefined, t('rp.exported'))}
            />
          ) : (
            <section className="card pad empty">
              <span className="em-ic">
                <Icon name="render" size={22} />
              </span>
              <p className="muted t-13">{t('rp.none')}</p>
            </section>
          )}
        </div>
      </div>
      {older.length > 0 && (
        <details className="card pad earlier-renders">
          <summary>{t('rp.earlier', { count: older.length })}</summary>
          <div className="col">
            {older.map((r, i) => (
              <RenderCard
                key={r.id}
                render={r}
                index={renders.length - 1 - i}
                cost={null}
                canEdit={canEdit}
                busy={busy}
                onApprove={(note) =>
                  void act(`/renders/${r.id}/approve`, note ? { note } : {}, t('rp.approved'))
                }
                onReject={(note) => void act(`/renders/${r.id}/reject`, { note }, t('rp.rejected'))}
                onExport={() => void act(`/renders/${r.id}/export`, undefined, t('rp.exported'))}
              />
            ))}
          </div>
        </details>
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
  const exported = Boolean(r.exportedAt);
  const short = (sha: string) => `sha256 ${sha.slice(0, 4)}…${sha.slice(-4)}`;
  const packageFiles: readonly {
    readonly name: string;
    readonly label: MessageKey;
    readonly href: string;
    readonly details: string;
    readonly checksum: string | null;
    readonly size: string | null;
  }[] = [
    ...(r.video
      ? [
          {
            name: 'video.mp4',
            label: 'rp.file.video' as const,
            href: assetContentUrl(r.video.id),
            details: `${String(r.video.width ?? '?')}×${String(r.video.height ?? '?')} · H.264 · AAC${
              r.durationMs ? ` · ${formatSeconds(r.durationMs)}` : ''
            }`,
            checksum: short(r.video.checksumSha256),
            size: formatBytes(r.video.sizeBytes),
          },
        ]
      : []),
    ...(r.subtitles
      ? [
          {
            name: 'captions.srt',
            label: 'rp.file.subtitles' as const,
            href: assetContentUrl(r.subtitles.id),
            details: r.burnInCaptions ? t('rp.captionsBurned') : t('rp.captionsSrt'),
            checksum: short(r.subtitles.checksumSha256),
            size: formatBytes(r.subtitles.sizeBytes),
          },
        ]
      : []),
    ...(r.thumbnail
      ? [
          {
            name: 'thumbnail.jpg',
            label: 'rp.file.thumbnail' as const,
            href: assetContentUrl(r.thumbnail.id),
            details: `${String(r.thumbnail.width ?? '?')}×${String(r.thumbnail.height ?? '?')}`,
            checksum: short(r.thumbnail.checksumSha256),
            size: formatBytes(r.thumbnail.sizeBytes),
          },
        ]
      : []),
    {
      name: 'manifest.json',
      label: 'rp.file.manifest',
      href: `/api/v1/renders/${r.id}/manifest`,
      details: t('rp.file.manifestDetails'),
      checksum: null,
      size: null,
    },
    {
      name: 'cost-report.json',
      label: 'rp.file.cost',
      href: `/api/v1/renders/${r.id}/cost-report`,
      details: t('rp.file.costDetails'),
      checksum: null,
      size: null,
    },
  ];
  return (
    <article className="card render-card" aria-label={t('rp.renderN', { index: props.index })}>
      <div className="card-head">
        <span className="step-n cur">3</span>
        <h3>{t('rp.reviewN', { index: props.index })}</h3>
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
        <span className="spacer" />
        <span className="t-12 muted">
          <LocalTime iso={r.createdAt} />
          {r.upscaledFrom ? ` · ${t('rp.upscaledFrom', { from: r.upscaledFrom })}` : ''}
        </span>
      </div>
      {(r.status === 'queued' || r.status === 'running' || r.job.errorCode || r.reviewNote) && (
        <div className="card-body col">
          {(r.status === 'queued' || r.status === 'running') && (
            <p role="status">{stageKey ? t(stageKey) : (r.stage ?? t('rp.waiting'))}…</p>
          )}
          {props.canEdit && (r.status === 'queued' || r.status === 'running') && (
            <CancelRunButton runId={r.job.productionRunId} what={t('rp.thisRender')} />
          )}
          {r.job.errorCode && (
            <p className="err-text" role="alert">
              {jobErrorText(r.job.errorCode, locale)}
              {r.job.errorMessage ? ` (${r.job.errorMessage})` : ''}
            </p>
          )}
          {r.reviewNote && (
            <p className="t-12 muted">{t('rp.reviewNote', { note: r.reviewNote })}</p>
          )}
        </div>
      )}

      {r.video && (
        <div className="row wrap render-body">
          <div className="col render-player-col">
            <video
              className="render-player"
              src={assetContentUrl(r.video.id)}
              poster={r.thumbnail ? assetContentUrl(r.thumbnail.id) : undefined}
              controls
              preload="metadata"
              playsInline
              aria-label={t('rp.play', { index: props.index })}
            />
            <span className="t-12 muted">
              {r.burnInCaptions ? t('rp.captionsBurned') : t('rp.captionsSrt')}
              {r.musicAssetId ? ` ${t('rp.withMusic')}` : ''}
            </span>
          </div>
          <div
            className="col render-checks"
            tabIndex={-1}
            onKeyDown={reviewable && props.canEdit ? onReviewKey : undefined}
          >
            <div className="col render-qc">
              <span className="eyebrow">{t('rp.qc')}</span>
              <div className="qc">
                <span className={errors.length === 0 ? 'check-ic ok' : 'check-ic danger'}>
                  <Icon name={errors.length === 0 ? 'check' : 'failed'} />
                </span>
                <span>
                  <b>{errors.length === 0 ? t('rp.passed') : t('rp.qcFailed')}</b>{' '}
                  <span className="muted">
                    · {r.qc?.measured.width ?? '?'}×{r.qc?.measured.height ?? '?'} ·{' '}
                    {r.qc?.measured.fps ?? '?'} fps · {r.qc?.measured.integratedLufs ?? '?'} LUFS
                  </span>
                </span>
              </div>
              {warnings.length > 0 ? (
                <ul className="col plain-list" aria-label={t('rp.qcWarnings')}>
                  {groupWarnings(t, warnings).map((g) => (
                    <li key={g.key} className="qc">
                      <span className="check-ic review">
                        <Icon name="warning" />
                      </span>
                      <span>{g.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="t-12 muted">{t('rp.noWarnings')}</p>
              )}
              {props.cost && (
                <p className="t-12 muted" aria-label={t('rp.costSummary')}>
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
              )}
            </div>
            {props.canEdit && reviewable && (
              <section className="col render-decision" aria-label={t('review.decision')}>
                <div className="row">
                  <span className="eyebrow">{t('rp.gate')}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={checklist.checkAll}
                    aria-keyshortcuts="C"
                  >
                    <Icon name="check" /> {t('review.checkAll')} <kbd aria-hidden="true">C</kbd>
                  </button>
                </div>
                <ReviewChecklist items={items} state={checklist} />
                <label className="field">
                  {t('rp.note')} <span className="hint">{t('rp.noteHint')}</span>
                  <input
                    id={`render-note-${r.id}`}
                    className="input"
                    value={note}
                    maxLength={2000}
                    onChange={(e) => {
                      setNote(e.target.value);
                    }}
                  />
                </label>
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn success"
                    disabled={props.busy}
                    aria-keyshortcuts="A"
                    onClick={() => {
                      props.onApprove(note.trim());
                    }}
                  >
                    <Icon name="check" /> {t('rp.approve')} <kbd aria-hidden="true">A</kbd>
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={props.busy || note.trim() === ''}
                    onClick={() => {
                      props.onReject(note.trim());
                    }}
                  >
                    <Icon name="message" /> {t('rp.reject')} <kbd aria-hidden="true">R</kbd>
                  </button>
                </div>
                {checklist.unchecked > 0 && (
                  <p className="t-12 muted">
                    {t('review.uncheckedHint', { count: checklist.unchecked })}
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      )}

      {r.video && (
        <section className="render-export" aria-label={t('rp.exportTitle')}>
          <div className="card-head">
            <span className={exported ? 'step-n done' : 'step-n'}>
              {exported ? <Icon name="check" size={12} /> : '4'}
            </span>
            <h3>{t('rp.exportTitle')}</h3>
            {!exported && r.reviewStatus !== 'approved' && (
              <span className="badge neutral">
                <Icon name="lock" size={13} />
                {t('rp.exportLocked')}
              </span>
            )}
            <span className="spacer" />
            {props.canEdit && r.reviewStatus === 'approved' && !exported && (
              <button
                type="button"
                className="btn primary"
                disabled={props.busy}
                onClick={props.onExport}
              >
                <Icon name="download" /> {t('rp.export')}
              </button>
            )}
          </div>
          <div className="table-box">
            <table
              className="table"
              aria-label={exported ? t('rp.downloads') : t('rp.packageFiles')}
            >
              <thead>
                <tr>
                  <th>{t('rp.col.file')}</th>
                  <th>{t('rp.col.details')}</th>
                  <th>{t('rp.col.checksum')}</th>
                  <th className="r">{t('rp.col.size')}</th>
                </tr>
              </thead>
              <tbody>
                {packageFiles.map((f) => (
                  <tr key={f.name}>
                    <td>
                      <span className="col file-cell">
                        <b>{t(f.label)}</b>
                        {exported ? (
                          <a href={f.href} download={f.name} className="t-12">
                            {f.name}
                          </a>
                        ) : (
                          <span className="t-12 muted">{f.name}</span>
                        )}
                      </span>
                    </td>
                    <td className="muted">{f.details}</td>
                    <td className="mono muted">{f.checksum ?? '—'}</td>
                    <td className="r num">{f.size ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
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
