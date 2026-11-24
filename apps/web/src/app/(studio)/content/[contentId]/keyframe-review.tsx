'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import type { ImageEstimateDto, StoryboardImagesDto } from '@acf/contracts';

import { CostConfirmDialog } from '@/components/cost-confirm';
import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { ApprovalPill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { confirmReasons, type ConfirmReason } from '@/lib/cost-confirm';

/** What the storyboard says about a scene (shown above its candidates). */
export interface SceneBrief {
  readonly title: string;
  readonly detail: string;
}

/** Candidates added by "more candidates". */
const MORE = 2;

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

/**
 * Keyframe review, gate 3 (redesign canvas "Gate 3 · Pick keyframes"): one scene at a time, full
 * screen. The strip shows every scene and whether it has a keyframe; the candidates are large; the
 * side card chooses the selected candidate (approving it first) and moves to the next scene that
 * still needs one. Keys: ← → scene, 1–4 select a candidate, Enter choose, G more candidates.
 * Choosing starts nothing paid; "more candidates" shows its price and asks above the threshold.
 */
export function KeyframeReview(props: {
  readonly images: StoryboardImagesDto;
  readonly scenes: Readonly<Record<string, SceneBrief>>;
  readonly subtitle: string;
  readonly clips: { readonly done: number; readonly total: number };
  readonly voice: { readonly done: number; readonly total: number; readonly enabled: boolean };
  readonly confirmThresholdUsd: string;
}) {
  const t = useT();
  const router = useRouter();
  const { images } = props;
  const scenes = images.scenes;
  const firstOpen = scenes.find((s) => !s.keyframe) ?? scenes[0];
  const [requested, setRequested] = useState<boolean | null>(null);
  const fromLink = useSyncExternalStore(
    subscribeHash,
    () => /^#(keyframes|scenes)\?.*focus/.test(window.location.hash),
    () => false,
  );
  const open = requested ?? fromLink;
  const [sceneId, setSceneId] = useState(firstOpen?.sceneId ?? '');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    plan: ImageEstimateDto;
    reasons: ConfirmReason[];
  } | null>(null);

  const index = Math.max(
    0,
    scenes.findIndex((s) => s.sceneId === sceneId),
  );
  const scene = scenes[index];
  const chosen = scenes.filter((s) => s.keyframe !== null).length;
  const selectedId = picked ?? scene?.keyframe?.id ?? scene?.candidates[0]?.id ?? null;
  const selectedIndex = scene?.candidates.findIndex((c) => c.id === selectedId) ?? -1;

  useEffect(() => {
    if (!open) return;
    document.body.classList.add('focus-open');
    return () => {
      document.body.classList.remove('focus-open');
    };
  }, [open]);

  if (scenes.length === 0 || !scene) return null;

  function go(step: number) {
    const next = scenes[(index + step + scenes.length) % scenes.length];
    if (next) {
      setSceneId(next.sceneId);
      setPicked(null);
      setError(null);
    }
  }

  async function choose() {
    if (!scene || !selectedId) return;
    const asset = scene.candidates.find((c) => c.id === selectedId);
    if (!asset) return;
    setBusy(true);
    setError(null);
    if (asset.approvalStatus !== 'approved') {
      const approved = await mutate('POST', `/assets/${asset.id}/approve`, {});
      if (!approved.ok) {
        setBusy(false);
        setError(errorText(approved));
        return;
      }
    }
    const r = await mutate('PUT', `/scenes/${scene.sceneId}/keyframe`, { assetId: asset.id });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(t('kf.chosen', { number: scene.sceneNumber }));
    // Next scene that still needs a keyframe, after this one.
    const rest = [...scenes.slice(index + 1), ...scenes.slice(0, index)];
    const next = rest.find((s) => !s.keyframe);
    if (next) {
      setSceneId(next.sceneId);
      setPicked(null);
    }
    router.refresh();
  }

  async function generate(plan: ImageEstimateDto) {
    if (!scene) return;
    setPending(null);
    setBusy(true);
    const r = await mutate('POST', `/storyboards/${images.storyboardVersionId}/images/generate`, {
      count: MORE,
      sceneIds: [scene.sceneId],
      regenerate: true,
      ...(plan.unknownCost ? { acceptUnknownCost: true } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(t('kf.more', { count: MORE, number: scene.sceneNumber }));
    router.refresh();
  }

  async function more() {
    if (!scene) return;
    setBusy(true);
    setError(null);
    const r = await mutate<ImageEstimateDto>(
      'POST',
      `/storyboards/${images.storyboardVersionId}/images/estimate`,
      { count: MORE, sceneIds: [scene.sceneId], regenerate: true },
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(errorText(r));
      return;
    }
    const reasons = confirmReasons({
      totalUsd: r.data.totalEstimatedUsd,
      unknown: r.data.unknownCost,
      thresholdUsd: props.confirmThresholdUsd,
    });
    if (reasons.length === 0) await generate(r.data);
    else setPending({ plan: r.data, reasons });
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') setRequested(false);
    else if (event.key === 'ArrowRight') go(1);
    else if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'Enter') void choose();
    else if (event.key.toLowerCase() === 'g') void more();
    else if (/^[1-9]$/.test(event.key)) {
      const candidate = scene?.candidates[Number(event.key) - 1];
      if (candidate) setPicked(candidate.id);
    } else return;
    event.preventDefault();
  }

  if (!open) {
    return (
      <div className="focus-bar kf-bar">
        <span className="badge review">
          <Icon name="shield" size={13} />
          {t('review.gateOf', { number: 3 })}
        </span>
        <span className="t-13 muted">
          {t('kf.barHint', { done: chosen, total: scenes.length })}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setRequested(true);
          }}
        >
          <Icon name="eye" />
          {t('kf.open')}
        </button>
      </div>
    );
  }

  const brief = props.scenes[scene.sceneId];
  const left = scenes.length - chosen;
  return (
    <div
      className="focus-review open kf-review"
      role="dialog"
      aria-modal="true"
      aria-label={t('kf.title')}
      tabIndex={-1}
      onKeyDown={onKey}
      ref={(el) => {
        el?.focus({ preventScroll: true });
      }}
    >
      <header className="focus-head">
        <button
          type="button"
          className="btn icon ghost"
          aria-label={t('review.focusClose')}
          onClick={() => {
            setRequested(false);
          }}
        >
          <Icon name="cancel" size={20} />
        </button>
        <div className="col focus-title">
          <span className="row">
            <span className="badge review">
              <Icon name="shield" size={13} />
              {t('review.gateOf', { number: 3 })}
            </span>
            <b>{t('kf.title')}</b>
          </span>
          <span className="t-12 muted">
            {props.subtitle} · {t('kf.left', { count: left })}
          </span>
        </div>
        <span className="spacer" />
        <div className="row kf-progress">
          <span className="t-13 muted num">
            {t('kf.chosenOf', { done: chosen, total: scenes.length })}
          </span>
          <span className="meter">
            <i
              className="ok"
              style={{ width: `${String(Math.round((chosen / scenes.length) * 100))}%` }}
            />
          </span>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setRequested(false);
          }}
        >
          {t('kf.doneForNow')}
        </button>
      </header>

      <nav className="kf-strip" aria-label={t('kf.scenes')}>
        {scenes.map((s) => (
          <button
            key={s.sceneId}
            type="button"
            className={s.sceneId === scene.sceneId ? 'sc on' : 'sc'}
            aria-current={s.sceneId === scene.sceneId ? 'true' : undefined}
            onClick={() => {
              setSceneId(s.sceneId);
              setPicked(null);
            }}
          >
            {s.keyframe ? (
              // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
              <img className="sc-thumb" src={assetContentUrl(s.keyframe.id)} alt="" />
            ) : (
              <span className="sc-thumb empty" />
            )}
            {s.sceneNumber}
            {s.keyframe ? (
              <Icon name="check" size={14} className="ok-ic" />
            ) : (
              <span> · {t('kf.pick')}</span>
            )}
          </button>
        ))}
        <span className="spacer" />
        <span className="t-12 muted row">
          <kbd>←</kbd>
          <kbd>→</kbd>
          {t('kf.keyScene')}
        </span>
        <span className="t-12 muted row">
          <kbd>1</kbd>–<kbd>4</kbd>
          {t('kf.keySelect')}
        </span>
        <span className="t-12 muted row">
          <kbd>G</kbd>
          {t('kf.keyMore')}
        </span>
      </nav>

      <div className="focus-body">
        <section className="col kf-main" aria-label={t('kf.sceneN', { number: scene.sceneNumber })}>
          <div className="row wrap kf-scene-head">
            <span className="scene-no">{String(scene.sceneNumber).padStart(2, '0')}</span>
            <h2>{brief?.title ?? t('kf.sceneN', { number: scene.sceneNumber })}</h2>
            {brief?.detail && <span className="badge neutral">{brief.detail}</span>}
          </div>
          <ul className="kf-grid" aria-label={t('kf.candidates')}>
            {scene.candidates.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="cand"
                  aria-pressed={c.id === selectedId}
                  aria-label={t('kf.candidate', { index: i + 1 })}
                  onClick={() => {
                    setPicked(c.id);
                  }}
                >
                  <span className={c.id === selectedId ? 'cand-img sel' : 'cand-img'}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API stream */}
                    <img src={assetContentUrl(c.id)} alt="" />
                    <kbd className="knum">{i + 1}</kbd>
                    {scene.keyframe?.id === c.id && (
                      <span className="tag">{t('img.keyframe')}</span>
                    )}
                  </span>
                  <span className="row t-13">
                    <ApprovalPill status={c.approvalStatus} />
                  </span>
                </button>
              </li>
            ))}
            {scene.activeJob && (
              <li>
                <div className="cand">
                  <span className="cand-img empty">
                    <Icon name="resume" size={24} />
                  </span>
                  <span className="badge info">{t('kf.generating')}</span>
                </div>
              </li>
            )}
          </ul>
          {scene.candidates.length === 0 && !scene.activeJob && (
            <p className="muted t-13">{t('img.none')}</p>
          )}
          <div className="card pad col kf-prompt">
            <span className="eyebrow">{t('kf.prompt')}</span>
            <p className="t-13">{scene.imagePrompt}</p>
          </div>
        </section>

        <aside className="col focus-side">
          <section
            className="card raised"
            aria-label={t('kf.sceneN', { number: scene.sceneNumber })}
          >
            <div className="card-head">
              <h3>{t('kf.sceneN', { number: scene.sceneNumber })}</h3>
              <span className="spacer" />
              {scene.keyframe ? (
                <span className="badge success">
                  <Icon name="check" size={13} />
                  {t('img.chosen')}
                </span>
              ) : (
                <span className="badge review">
                  <Icon name="eye" size={13} />
                  {t('kf.pick1')}
                </span>
              )}
            </div>
            <div className="card-body col kf-actions">
              <button
                type="button"
                className="btn primary lg"
                disabled={busy || !selectedId || selectedId === scene.keyframe?.id}
                onClick={() => void choose()}
              >
                <Icon name="check" />
                {t('kf.choose', { index: selectedIndex + 1 })}
                <kbd aria-hidden="true">↵</kbd>
              </button>
              <p className="t-12 muted">{t('kf.chooseNote')}</p>
              <div className="divider" />
              <button
                type="button"
                className="btn"
                disabled={busy || scene.activeJob !== null}
                onClick={() => void more()}
              >
                <Icon name="generate" />
                {t('kf.moreButton', { count: MORE })}
                <kbd aria-hidden="true">G</kbd>
              </button>
              {error && (
                <p className="err-text" role="alert">
                  {error}
                </p>
              )}
            </div>
          </section>
          <section className="card pad col kf-gate">
            <span className="eyebrow">{t('kf.gateWhen')}</span>
            <Criterion
              done={chosen === scenes.length}
              text={t('kf.c.keyframes', { done: chosen, total: scenes.length })}
            />
            <Criterion
              done={props.clips.done === props.clips.total && props.clips.total > 0}
              text={t('kf.c.clips', props.clips)}
            />
            <Criterion
              done={!props.voice.enabled || props.voice.done === props.voice.total}
              text={
                props.voice.enabled
                  ? t('kf.c.voice', { done: props.voice.done, total: props.voice.total })
                  : t('kf.c.voiceOff')
              }
            />
          </section>
        </aside>
      </div>
      {pending && (
        <CostConfirmDialog
          open
          title={t('kf.confirmTitle', { count: MORE, number: scene.sceneNumber })}
          description={pending.plan.modelKey}
          lines={pending.plan.scenes
            .filter((s) => s.action === 'generate')
            .map((s) => ({
              label: t('clips.scene', { number: s.sceneNumber }),
              usd: s.estimatedUsd,
            }))}
          totalUsd={pending.plan.totalEstimatedUsd}
          unknown={pending.plan.unknownCost}
          thresholdUsd={props.confirmThresholdUsd}
          reasons={pending.reasons}
          action={t('clips.confirmAction')}
          busy={busy}
          onCancel={() => {
            setPending(null);
          }}
          onConfirm={() => void generate(pending.plan)}
        />
      )}
    </div>
  );
}

function Criterion(props: { readonly done: boolean; readonly text: string }) {
  return (
    <div className="row t-13">
      <span className={props.done ? 'check-ic ok' : 'check-ic muted'}>
        <Icon name={props.done ? 'check' : 'history'} />
      </span>
      {props.text}
    </div>
  );
}
