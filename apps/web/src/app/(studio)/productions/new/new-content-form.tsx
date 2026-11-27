'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  PRODUCT_REFERENCES_MAX,
  type AiModelDto,
  type AiRouteDto,
  type AssetDto,
  type AspectRatio,
  type BudgetDto,
  type ContentBrief,
  type ContentItemDto,
  type VersionedEntityDto,
  type VoiceProfileDto,
} from '@acf/contracts';

import { AssetPicker } from '@/components/asset-picker';
import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { toast } from '@/components/toast';
import { errorText, mutate, uploadImage } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { platformOptions } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { addUsd, formatEstimateUsd, formatUsd } from '@/lib/money';
import { projectInitials, projectSwatch } from '@/lib/project-swatch';
import { estimateRun, type RunStep } from '@/lib/run-estimate';

export interface NewContentProject {
  readonly id: string;
  readonly name: string;
  readonly defaultLanguage: string;
  readonly characters: readonly VersionedEntityDto[];
  readonly environments: readonly VersionedEntityDto[];
  readonly voiceProfiles: readonly VoiceProfileDto[];
  readonly budget: BudgetDto | null;
}

type Platform = ReturnType<typeof platformOptions>[number]['value'];

interface Draft {
  projectId: string;
  title: string;
  topic: string;
  audience: string;
  tone: string;
  objective: string;
  duration: number;
  customDuration: boolean;
  aspectRatio: AspectRatio;
  platform: Platform | '';
  language: string;
  characterId: string;
  environmentId: string;
  photos: string[];
  voiceEnabled: boolean;
  voiceProfileId: string;
}

/** Per-browser draft of the form (a convenience only: nothing is sent until Create). */
const DRAFT_KEY = 'acf:new-content-draft';
const DURATIONS = [15, 30, 60] as const;
const RATIOS: readonly AspectRatio[] = ['9:16', '1:1', '16:9'];
const LANGUAGES = ['en', 'vi'] as const;
const PHOTO_TYPES = ['reference', 'image'] as const;
/** Candidates per scene of the first keyframe run (the Scenes stage default). */
const CANDIDATES = 1;

const STEP_LABEL: Readonly<Record<RunStep, MessageKey>> = {
  script: 'brief.cost.script',
  storyboard: 'brief.cost.storyboard',
  keyframes: 'brief.cost.keyframes',
  clips: 'brief.cost.clips',
  voice: 'brief.cost.voice',
  render: 'brief.cost.render',
};

function emptyDraft(project: NewContentProject): Draft {
  return {
    projectId: project.id,
    title: '',
    topic: '',
    audience: '',
    tone: '',
    objective: '',
    duration: 30,
    customDuration: false,
    aspectRatio: '9:16',
    platform: '',
    language: project.defaultLanguage,
    characterId: '',
    environmentId: '',
    photos: [],
    voiceEnabled: true,
    voiceProfileId: project.voiceProfiles[0]?.id ?? '',
  };
}

function readDraft(): Partial<Draft> | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<Draft>) : null;
  } catch {
    return null;
  }
}

/** Percentage of `part` in `whole` (decimal strings), 0–100, for meters only. */
function percent(part: string, whole: string): number {
  const w = Number(whole);
  if (!(w > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((Number(part) / w) * 100)));
}

/** Subtracts decimal USD strings for display (never below zero). */
function minusUsd(a: string, b: string): string {
  const diff = Number(a) - Number(b);
  return diff > 0 ? diff.toFixed(2) : '0';
}

/**
 * New content as a full page (redesign canvas "New content"): the brief is the most important
 * input of a run, so it gets four sections, a live brief check and the estimated cost of the
 * whole run. "Create & write script" creates the item and starts only the script; every later
 * step still waits for its approval gate.
 */
function NewContentFormInner(props: {
  readonly projects: readonly NewContentProject[];
  readonly initialProjectId: string;
  readonly routes: readonly AiRouteDto[];
  readonly models: readonly AiModelDto[];
}) {
  const t = useT();
  const router = useRouter();
  const first = props.projects.find((p) => p.id === props.initialProjectId) ?? props.projects[0];
  // Rendered on the client only (see NewContentForm), so the browser draft can seed the state.
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (!first) return null;
    const saved = readDraft();
    return saved && props.projects.some((p) => p.id === saved.projectId)
      ? { ...emptyDraft(first), ...saved }
      : emptyDraft(first);
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<'script' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const slot = useSyncExternalStore(
    noSubscription,
    () => document.getElementById('topbar-slot'),
    () => null,
  );
  const fileInput = useRef<HTMLInputElement>(null);

  // Keep the draft in this browser (debounced).
  useEffect(() => {
    if (!draft) return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        setSavedAt(Date.now());
      } catch {
        // Storage can be unavailable (private mode): the form still works without it.
      }
    }, 600);
    return () => {
      window.clearTimeout(id);
    };
  }, [draft]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const project = props.projects.find((p) => p.id === draft?.projectId) ?? first;
  const voiceProfile = project?.voiceProfiles.find((v) => v.id === draft?.voiceProfileId);
  const estimate = useMemo(
    () =>
      estimateRun({
        durationSeconds: draft?.duration ?? 30,
        candidatesPerScene: CANDIDATES,
        routes: props.routes,
        models: props.models,
        voiceModelKey: draft?.voiceEnabled ? (voiceProfile?.modelKey ?? '') : null,
      }),
    [draft?.duration, draft?.voiceEnabled, voiceProfile, props.routes, props.models],
  );

  if (!draft || !project) {
    return (
      <section className="card pad" role="status">
        {t('brief.noProjects')}
      </section>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };
  const changeProject = (id: string) => {
    const next = props.projects.find((p) => p.id === id);
    if (!next) return;
    // Brand, photos and voice belong to a project: they reset with it.
    setDraft((d) =>
      d
        ? {
            ...d,
            projectId: id,
            language: next.defaultLanguage,
            characterId: '',
            environmentId: '',
            photos: [],
            voiceProfileId: next.voiceProfiles[0]?.id ?? '',
          }
        : d,
    );
  };

  const scriptLine = estimate.lines.find((l) => l.step === 'script');
  const total = formatEstimateUsd(estimate.knownUsd);
  const budget = project.budget;
  const afterRun = budget ? minusUsd(budget.remainingUsd, estimate.knownUsd) : null;

  // Brief check: what is missing blocks; what is weak only warns.
  const missing = [
    !draft.title.trim() && t('brief.check.needTitle'),
    !draft.topic.trim() && t('brief.check.needTopic'),
  ].filter((x): x is string => typeof x === 'string');
  const brand = [
    t('brief.check.photos', { count: draft.photos.length }),
    t('brief.check.characters', { count: draft.characterId ? 1 : 0 }),
    t('brief.check.environments', { count: draft.environmentId ? 1 : 0 }),
  ].join(' · ');
  const filled = Boolean(draft.audience.trim() && draft.objective.trim());

  async function submit(writeScript: boolean) {
    if (!draft || !project || missing.length > 0) {
      setError(missing.join(' · ') || null);
      return;
    }
    setBusy(writeScript ? 'script' : 'draft');
    setError(null);
    const brief: ContentBrief = { topic: draft.topic.trim() };
    if (draft.audience.trim()) brief.audience = draft.audience.trim();
    if (draft.tone.trim()) brief.tone = draft.tone.trim();
    if (draft.objective.trim()) brief.objective = draft.objective.trim();
    if (draft.characterId) brief.characterId = draft.characterId;
    if (draft.environmentId) brief.environmentId = draft.environmentId;
    if (draft.photos.length > 0) brief.productAssetIds = draft.photos;
    const created = await mutate<ContentItemDto>('POST', `/projects/${project.id}/content`, {
      title: draft.title.trim(),
      format: 'short_video',
      targetDurationSeconds: draft.duration,
      aspectRatio: draft.aspectRatio,
      language: draft.language,
      brief,
      ...(draft.platform ? { targetPlatform: draft.platform } : {}),
    });
    if (!created.ok || !created.data) {
      setBusy(null);
      setError(errorText(created));
      return;
    }
    const id = created.data.id;
    const voice = await mutate('PATCH', `/content/${id}`, {
      voiceEnabled: draft.voiceEnabled,
      ...(draft.voiceEnabled && draft.voiceProfileId
        ? { voiceProfileId: draft.voiceProfileId }
        : {}),
    });
    if (!voice.ok) toast(errorText(voice));
    if (writeScript) {
      const run = await mutate('POST', `/content/${id}/scripts/generate`, {});
      if (!run.ok) toast(errorText(run));
    }
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to clean up without storage.
    }
    router.push(`/content/${id}#script`);
  }

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file || !draft || !project) return;
    setUploading(true);
    const r = await uploadImage<AssetDto>(project.id, file, { assetType: 'reference' });
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    if (!r.ok || !r.data) {
      setError(errorText(r));
      return;
    }
    set('photos', [...draft.photos, r.data.id].slice(0, PRODUCT_REFERENCES_MAX));
  }

  const savedText =
    savedAt === null
      ? null
      : t('brief.draftSaved', { seconds: Math.max(1, Math.round((now - savedAt) / 1000)) });

  const topbar: ReactNode = (
    <>
      {savedText && <span className="t-13 muted saved-note">{savedText}</span>}
      <Link className="btn" href="/productions">
        {t('common.cancel')}
      </Link>
    </>
  );

  return (
    <>
      {slot && createPortal(topbar, slot)}
      <div className="page-head">
        <div>
          <h1>{t('brief.title')}</h1>
          <p>{t('brief.lead')}</p>
        </div>
      </div>
      <form
        className="brief-layout"
        aria-label={t('form.newContentLabel')}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <div className="col brief-main">
          <section className="card pad col brief-section" aria-labelledby="brief-about">
            <div className="row">
              <span className="idx">1</span>
              <h3 id="brief-about">{t('brief.about')}</h3>
            </div>
            <div className="fgrid">
              <label className="field">
                {t('form.project')}
                <span className="select-wrap">
                  <span
                    className="sw"
                    aria-hidden="true"
                    style={{ background: projectSwatch(project.id) }}
                  >
                    {projectInitials(project.name)}
                  </span>
                  <select
                    className="input"
                    value={draft.projectId}
                    onChange={(e) => {
                      changeProject(e.target.value);
                    }}
                  >
                    {props.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <label className="field">
                {t('brief.workingTitle')}
                <input
                  className="input"
                  name="title"
                  required
                  maxLength={200}
                  placeholder={t('form.titlePlaceholder')}
                  value={draft.title}
                  onChange={(e) => {
                    set('title', e.target.value);
                  }}
                />
              </label>
            </div>
            <label className="field">
              {t('form.topic')}
              <textarea
                className="input"
                name="topic"
                required
                maxLength={500}
                rows={3}
                placeholder={t('form.topicPlaceholder')}
                value={draft.topic}
                onChange={(e) => {
                  set('topic', e.target.value);
                }}
              />
            </label>
            <div className="fgrid">
              {(['audience', 'tone', 'objective'] as const).map((key) => (
                <label key={key} className="field">
                  {t(`form.${key}`)}
                  <input
                    className="input"
                    name={key}
                    maxLength={key === 'tone' ? 200 : 500}
                    placeholder={t(`brief.placeholder.${key}`)}
                    value={draft[key]}
                    onChange={(e) => {
                      set(key, e.target.value);
                    }}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="card pad col brief-section" aria-labelledby="brief-format">
            <div className="row">
              <span className="idx">2</span>
              <h3 id="brief-format">{t('brief.format')}</h3>
            </div>
            <div className="fgrid">
              <div className="field" role="group" aria-label={t('brief.duration')}>
                {t('brief.duration')}
                <div className="seg">
                  {DURATIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={!draft.customDuration && draft.duration === s ? 'on' : undefined}
                      aria-pressed={!draft.customDuration && draft.duration === s}
                      onClick={() => {
                        setDraft((d) => (d ? { ...d, duration: s, customDuration: false } : d));
                      }}
                    >
                      {t('brief.seconds', { count: s })}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={draft.customDuration ? 'on' : undefined}
                    aria-pressed={draft.customDuration}
                    onClick={() => {
                      set('customDuration', true);
                    }}
                  >
                    {t('brief.custom')}
                  </button>
                </div>
                {draft.customDuration && (
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={600}
                    aria-label={t('brief.customSeconds')}
                    value={draft.duration}
                    onChange={(e) => {
                      set('duration', Math.min(600, Math.max(1, Number(e.target.value) || 1)));
                    }}
                  />
                )}
              </div>
              <div className="field" role="group" aria-label={t('form.aspectRatio')}>
                {t('form.aspectRatio')}
                <div className="seg">
                  {RATIOS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={draft.aspectRatio === r ? 'on' : undefined}
                      aria-pressed={draft.aspectRatio === r}
                      onClick={() => {
                        set('aspectRatio', r);
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                {t('form.platform')}
                <select
                  className="input"
                  value={draft.platform}
                  onChange={(e) => {
                    set('platform', e.target.value as Platform | '');
                  }}
                >
                  <option value="">{t('platform.none')}</option>
                  {platformOptions(t).map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('form.language')}
                <select
                  className="input"
                  value={draft.language}
                  onChange={(e) => {
                    set('language', e.target.value);
                  }}
                >
                  {[...new Set([project.defaultLanguage, ...LANGUAGES])].map((l) => (
                    <option key={l} value={l}>
                      {t(`brief.language.${l === 'vi' ? 'vi' : l === 'en' ? 'en' : 'other'}`, {
                        tag: l,
                      })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="card pad col brief-section" aria-labelledby="brief-look">
            <div className="row">
              <span className="idx">3</span>
              <h3 id="brief-look">{t('brief.look')}</h3>
              <span className="spacer" />
              <Link className="t-13" href={`/projects/${project.id}#brand`}>
                {t('brief.manageBrand')}
              </Link>
            </div>
            <div className="fgrid">
              <label className="field">
                {t('form.character')}
                <select
                  className="input"
                  value={draft.characterId}
                  onChange={(e) => {
                    set('characterId', e.target.value);
                  }}
                >
                  <option value="">{t('brief.noCharacter')}</option>
                  {project.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('brief.approvedVersion', {
                        name: c.name,
                        version: c.master?.version ?? 0,
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('form.environment')}
                <select
                  className="input"
                  value={draft.environmentId}
                  onChange={(e) => {
                    set('environmentId', e.target.value);
                  }}
                >
                  <option value="">{t('brief.noEnvironment')}</option>
                  {project.environments.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('brief.approvedVersion', {
                        name: c.name,
                        version: c.master?.version ?? 0,
                      })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field" role="group" aria-labelledby="brief-photos">
              <span id="brief-photos">
                {t('photos.label')}{' '}
                <span className="hint">
                  {t('brief.photosHint', { max: PRODUCT_REFERENCES_MAX })}
                </span>
              </span>
              <div className="row wrap brief-photos">
                {draft.photos.map((id, i) => (
                  <div key={id} className="photo">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API stream */}
                    <img src={assetContentUrl(id)} alt={t('brief.photoAlt', { n: i + 1 })} />
                    <button
                      className="rm"
                      type="button"
                      aria-label={t('brief.removePhoto', { n: i + 1 })}
                      onClick={() => {
                        set(
                          'photos',
                          draft.photos.filter((p) => p !== id),
                        );
                      }}
                    >
                      <Icon name="cancel" size={14} />
                    </button>
                  </div>
                ))}
                {draft.photos.length < PRODUCT_REFERENCES_MAX && (
                  <>
                    <button
                      className="photo add"
                      type="button"
                      disabled={uploading}
                      onClick={() => fileInput.current?.click()}
                    >
                      <span className="col">
                        <Icon name="upload" size={20} />
                        {uploading ? t('brief.uploading') : t('brief.upload')}
                      </span>
                    </button>
                    <button
                      className="photo add"
                      type="button"
                      onClick={() => {
                        setPicker(true);
                      }}
                    >
                      <span className="col">
                        <Icon name="image" size={20} />
                        {t('nav.library')}
                      </span>
                    </button>
                  </>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => void upload(e.target.files)}
                />
              </div>
            </div>
          </section>

          <section className="card pad col brief-section" aria-labelledby="brief-audio">
            <div className="row">
              <span className="idx">4</span>
              <h3 id="brief-audio">{t('brief.audio')}</h3>
            </div>
            <div className={draft.voiceEnabled ? 'audio-row on' : 'audio-row'}>
              <button
                className={draft.voiceEnabled ? 'switch on' : 'switch'}
                type="button"
                role="switch"
                aria-checked={draft.voiceEnabled}
                aria-label={t('brief.voiceOver')}
                onClick={() => {
                  set('voiceEnabled', !draft.voiceEnabled);
                }}
              />
              <div className="col audio-text">
                <b>{t('brief.voiceOver')}</b>
                <span className="t-13 muted">{t('brief.voiceOverHint')}</span>
              </div>
              {draft.voiceEnabled && (
                <label className="field audio-profile">
                  {t('brief.voiceProfile')}
                  {project.voiceProfiles.length > 0 ? (
                    <select
                      className="input"
                      value={draft.voiceProfileId}
                      onChange={(e) => {
                        set('voiceProfileId', e.target.value);
                      }}
                    >
                      {project.voiceProfiles.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.language}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="hint">
                      {t('brief.noVoiceProfile')}{' '}
                      <Link href="/settings/voices">{t('brief.addVoiceProfile')}</Link>
                    </span>
                  )}
                </label>
              )}
            </div>
            <div className="audio-row">
              <span className="switch" aria-hidden="true" />
              <div className="col audio-text">
                <b>{t('brief.music')}</b>
                <span className="t-13 muted">{t('brief.musicHint')}</span>
              </div>
            </div>
          </section>
        </div>

        <aside className="col brief-side">
          <section className="card" aria-labelledby="brief-check">
            <div className="card-head">
              <span className={missing.length ? 'check-ic review' : 'check-ic ok'}>
                <Icon name={missing.length ? 'warning' : 'check'} size={20} />
              </span>
              <h3 id="brief-check">{t('brief.check.title')}</h3>
              <span className="spacer" />
              {missing.length ? (
                <span className="badge review">{t('brief.check.incomplete')}</span>
              ) : (
                <span className="badge success">{t('brief.check.ready')}</span>
              )}
            </div>
            <ul className="card-body col check-list">
              {missing.map((m) => (
                <li key={m} className="row t-13">
                  <span className="check-ic danger">
                    <Icon name="failed" />
                  </span>
                  {m}
                </li>
              ))}
              <li className="row t-13">
                <span className={filled ? 'check-ic ok' : 'check-ic review'}>
                  <Icon name={filled ? 'check' : 'warning'} />
                </span>
                {filled ? t('brief.check.filled') : t('brief.check.thin')}
              </li>
              <li className="row t-13">
                <span className="check-ic ok">
                  <Icon name="check" />
                </span>
                {brand}
              </li>
              <li className="row t-13">
                <span className="check-ic review">
                  <Icon name="warning" />
                </span>
                {t('brief.check.noCta')}
              </li>
            </ul>
          </section>

          <section className="card" aria-labelledby="brief-cost">
            <div className="card-head">
              <Icon name="costs" size={20} />
              <h3 id="brief-cost">{t('brief.cost.title')}</h3>
            </div>
            <div className="card-body col cost-body">
              <dl className="kv">
                {estimate.lines.map((line) => (
                  <CostRow
                    key={line.step}
                    label={t(STEP_LABEL[line.step], {
                      model: line.model ?? t('brief.cost.notRouted'),
                      scenes: estimate.scenes,
                      candidates: CANDIDATES,
                      seconds: draft.duration,
                    })}
                    amount={line.amountUsd === null ? null : formatEstimateUsd(line.amountUsd)}
                    unknown={t('brief.cost.unknown')}
                  />
                ))}
              </dl>
              <div className="divider" />
              <div className="row">
                <b>{t('brief.cost.total')}</b>
                <span className="spacer" />
                <b className="num cost-total">
                  {total}
                  {estimate.hasUnknown ? ' + ?' : ''}
                </b>
              </div>
              {estimate.hasUnknown && (
                <div className="callout review t-13">
                  <Icon name="costs" />
                  <span className="txt">
                    {t('brief.cost.unknownNote')}{' '}
                    <Link href="/settings/models">{t('brief.cost.addPrice')}</Link>.
                  </span>
                </div>
              )}
              {budget && afterRun !== null && (
                <>
                  <div className="meter">
                    <i
                      className="spent"
                      style={{
                        width: `${String(percent(budget.spentUsd, budget.monthly.limitUsd))}%`,
                      }}
                    />
                    <i
                      className="reserved"
                      style={{
                        width: `${String(percent(addUsd(budget.reservedUsd, estimate.knownUsd), budget.monthly.limitUsd))}%`,
                      }}
                    />
                  </div>
                  <span className="t-12 muted">
                    {t('brief.cost.budgetAfter', {
                      project: project.name,
                      left: formatUsd(afterRun),
                      limit: formatUsd(budget.monthly.limitUsd),
                    })}
                  </span>
                </>
              )}
            </div>
          </section>

          <div className="col submit-col">
            {error && (
              <p className="err-text" role="alert">
                {error}
              </p>
            )}
            <button className="btn primary lg" type="submit" disabled={busy !== null}>
              <Icon name="generate" />
              {busy === 'script' ? t('brief.creating') : t('brief.createScript')}
              {scriptLine?.amountUsd && (
                <span className="cost">{formatEstimateUsd(scriptLine.amountUsd)}</span>
              )}
            </button>
            <button
              className="btn lg"
              type="button"
              disabled={busy !== null}
              onClick={() => void submit(false)}
            >
              {busy === 'draft' ? t('brief.creating') : t('brief.saveDraft')}
            </button>
            <span className="t-12 muted submit-note">{t('brief.onlyScript')}</span>
          </div>
        </aside>
      </form>
      {picker && (
        <AssetPicker
          projectId={project.id}
          open
          multiple
          title={t('photos.pickerTitle', { max: PRODUCT_REFERENCES_MAX })}
          types={PHOTO_TYPES}
          selected={draft.photos}
          onClose={() => {
            setPicker(false);
          }}
          onDone={(ids) => {
            setPicker(false);
            set('photos', ids.slice(0, PRODUCT_REFERENCES_MAX));
          }}
        />
      )}
    </>
  );
}

const noSubscription = (): (() => void) => () => undefined;

type FormProps = Parameters<typeof NewContentFormInner>[0];

/** Client-only: the form starts from this browser's saved draft, which the server cannot know. */
export function NewContentForm(props: FormProps) {
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!mounted) {
    return (
      <div className="page-head">
        <div>
          <span className="sk" style={{ display: 'block', width: 240, height: 28 }} />
        </div>
      </div>
    );
  }
  return <NewContentFormInner {...props} />;
}

function CostRow(props: {
  readonly label: string;
  readonly amount: string | null;
  readonly unknown: string;
}) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd className={props.amount === null ? 'unknown' : undefined}>
        {props.amount ?? props.unknown}
      </dd>
    </>
  );
}
