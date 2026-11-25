'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AiModelDto, ImportAiModelsResponseDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { countedLines } from '@/lib/format';

const CATALOGS = ['llm', 'image', 'video', 'tts'] as const;

const METRICS = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'request',
  'output_images',
  'input_images',
  'output_pixels',
  'input_pixels',
  'output_image_tokens',
  'input_image_tokens',
  'output_video_seconds',
  'output_video_tokens',
  'input_characters',
] as const;

const ACTION_TONE = {
  created: 'green',
  updated: 'purple',
  unchanged: 'gray',
  refused: 'red',
} as const;

/**
 * Import models from OpenRouter's public catalog (P1d, operators): preview what would be
 * recorded (prices, parameters, limits), then import. New models start disabled; prices are only
 * appended. Same code as `pnpm ai:registry model import-openrouter*`; every change is audited.
 */
export function ImportModelsPanel(props: { readonly known: readonly string[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<(typeof CATALOGS)[number]>('llm');
  const [keys, setKeys] = useState('');
  const [tier, setTier] = useState('economy');
  const [result, setResult] = useState<ImportAiModelsResponseDto | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelKeys = keys
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

  async function send(apply: boolean) {
    setBusy(true);
    setError(null);
    const r = await mutate<ImportAiModelsResponseDto>('POST', '/ai/models/import', {
      catalog,
      modelKeys,
      tier,
      apply,
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(errorText(r));
      return;
    }
    setResult(r.data);
    setFetchedAt(new Date().toISOString());
    setOpen(false);
    if (apply) {
      toast(t('import.done'));
      router.refresh();
    }
  }

  // Preview groups (canvas "Import preview"): new models, updates of known ones, refused.
  const known = new Set(props.known);
  const entries = result?.entries ?? [];
  const added = entries.filter((e) => e.ok && !known.has(e.modelKey));
  const updated = entries.filter((e) => e.ok && known.has(e.modelKey));
  const refused = entries.filter((e) => !e.ok);
  const changes = added.length + updated.length;

  return (
    <>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Icon name="download" /> {t('import.open')}
        </button>
      </div>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('import.title')}
        description={t('import.hint')}
      >
        <div className="col import-form">
          <label className="field">
            {t('import.catalog')}
            <select
              className="input"
              value={catalog}
              onChange={(e) => {
                setCatalog(e.target.value as typeof catalog);
              }}
            >
              {CATALOGS.map((c) => (
                <option key={c} value={c}>
                  {t(`import.cat.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field import-keys">
            {t('import.keys')} <span className="hint">{t('import.keysHint')}</span>
            <textarea
              className="input"
              rows={3}
              value={keys}
              placeholder="google/gemini-3.5-flash-lite"
              onChange={(e) => {
                setKeys(e.target.value);
              }}
            />
          </label>
          <label className="field">
            {t('import.tier')}
            <select
              className="input"
              value={tier}
              onChange={(e) => {
                setTier(e.target.value);
              }}
            >
              <option value="economy">{t('import.tier.economy')}</option>
              <option value="balanced">{t('import.tier.balanced')}</option>
              <option value="premium">{t('import.tier.premium')}</option>
            </select>
          </label>
          {error && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
          <div className="row import-actions">
            <span className="spacer" />
            <button
              type="button"
              className="btn primary"
              disabled={busy || modelKeys.length === 0 || modelKeys.length > 10}
              onClick={() => void send(false)}
            >
              {t('import.preview')}
            </button>
          </div>
        </div>
      </Modal>

      {result && (
        <section className="card import-card" aria-label={t('import.previewLabel')}>
          <div className="card-head">
            <Icon name="resume" size={20} />
            <h3>{result.applied ? t('import.appliedTitle') : t('import.previewTitle')}</h3>
            <span className="t-13 muted">
              {result.applied
                ? t('import.appliedNote')
                : t('import.previewNote', {
                    time: fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '',
                  })}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setResult(null);
              }}
            >
              {result.applied ? t('common.close') : t('import.discard')}
            </button>
            {!result.applied && (
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || changes === 0}
                onClick={() => void send(true)}
              >
                {t('import.apply', { count: changes })}
              </button>
            )}
          </div>
          <div className="card-body col import-diff">
            {added.length > 0 && (
              <DiffRow
                tone="success"
                icon="plus"
                badge={t('import.newCount', { count: added.length })}
                text={t('import.newText')}
                entries={added}
              />
            )}
            {updated.length > 0 && (
              <DiffRow
                tone="review"
                icon="dollar"
                badge={t('import.updateCount', { count: updated.length })}
                text={t('import.updateText')}
                entries={updated}
              />
            )}
            {refused.length > 0 && (
              <DiffRow
                tone="neutral"
                icon="failed"
                badge={t('import.refusedCount', { count: refused.length })}
                text={t('import.refusedText')}
                entries={refused}
              />
            )}
          </div>
        </section>
      )}
    </>
  );
}

function DiffRow(props: {
  readonly tone: 'success' | 'review' | 'neutral';
  readonly icon: 'plus' | 'dollar' | 'failed';
  readonly badge: string;
  readonly text: string;
  readonly entries: ImportAiModelsResponseDto['entries'];
}) {
  const t = useT();
  return (
    <details className="diff">
      <summary className="row wrap">
        <span className={`badge ${props.tone}`}>
          <Icon name={props.icon} size={13} />
          {props.badge}
        </span>
        <span className="t-13">{props.text}</span>
      </summary>
      <ul className="col plain-list">
        {props.entries.map((e) => (
          <li key={e.modelKey} className="t-13">
            <b className="mono">{e.modelKey}</b>{' '}
            {e.action && (
              <Pill tone={ACTION_TONE[e.action]}>
                {t(`import.action.${e.action}`)}
                {e.newPrices ? ` ${t('import.newPrices', { count: e.newPrices })}` : ''}
              </Pill>
            )}
            <div className="t-12 muted">{e.summary ?? e.reason}</div>
            {countedLines([...e.warnings, ...e.detail]).map((w) => (
              <div key={w.text} className="t-12 muted">
                {w.text}
                {w.count > 1 ? ` (×${String(w.count)})` : ''}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Append one price to a model (P1d, operators). Earlier prices are kept for history. */
export function AddPriceButton({ model }: { readonly model: AiModelDto }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('input_tokens');
  const [usd, setUsd] = useState('');
  const [source, setSource] = useState('official_page');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const r = await mutate('POST', `/ai/models/${model.id}/prices`, {
      metric,
      usdPerUnit: usd.trim(),
      source,
      sourceUrl: url.trim(),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setOpen(false);
    toast(t('price.added'));
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn small ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('price.add')}
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('price.title', { name: model.displayName })}
        description={t('price.desc')}
      >
        <div className="form">
          <label className="field">
            {t('price.metric')}
            <select
              value={metric}
              onChange={(e) => {
                setMetric(e.target.value as (typeof METRICS)[number]);
              }}
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {m.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('price.usd')}
            <input
              inputMode="decimal"
              value={usd}
              placeholder="0.0000001"
              onChange={(e) => {
                setUsd(e.target.value);
              }}
            />
          </label>
          <label className="field">
            {t('price.source')}
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
            >
              <option value="official_page">{t('price.source.official_page')}</option>
              <option value="official_api">{t('price.source.official_api')}</option>
              <option value="manual_estimate">{t('price.source.manual_estimate')}</option>
            </select>
          </label>
          <label className="field">
            {t('price.url')}
            <input
              type="url"
              value={url}
              placeholder="https://openrouter.ai/…"
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !/^\d+(\.\d+)?$/.test(usd.trim()) || !url.trim()}
              onClick={() => void save()}
            >
              {t('price.add')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
