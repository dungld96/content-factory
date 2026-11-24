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
export function ImportModelsPanel() {
  const t = useT();
  const router = useRouter();
  const [catalog, setCatalog] = useState<(typeof CATALOGS)[number]>('llm');
  const [keys, setKeys] = useState('');
  const [tier, setTier] = useState('economy');
  const [result, setResult] = useState<ImportAiModelsResponseDto | null>(null);
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
    if (apply) {
      toast(t('import.done'));
      router.refresh();
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="ai-import">
      <div className="section-head">
        <div>
          <h3 id="ai-import">{t('import.title')}</h3>
          <p>{t('import.hint')}</p>
        </div>
      </div>
      <div className="import-form">
        <label className="field">
          {t('import.catalog')}
          <select
            value={catalog}
            onChange={(e) => {
              setCatalog(e.target.value as typeof catalog);
              setResult(null);
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
          {t('import.keys')} <small>{t('import.keysHint')}</small>
          <textarea
            rows={3}
            value={keys}
            placeholder="google/gemini-3.5-flash-lite"
            onChange={(e) => {
              setKeys(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <label className="field">
          {t('import.tier')}
          <select
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
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || modelKeys.length === 0 || modelKeys.length > 10}
          onClick={() => void send(false)}
        >
          {t('import.preview')}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || result === null || result.applied || !result.entries.some((e) => e.ok)}
          onClick={() => void send(true)}
        >
          <Icon name="upload" /> {t('import.import')}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <ul className="plain-list import-result" aria-label={t('import.previewLabel')}>
          {result.entries.map((e) => (
            <li key={e.modelKey}>
              <b className="mono">{e.modelKey}</b>{' '}
              {e.action ? (
                <Pill tone={ACTION_TONE[e.action]}>
                  {t(`import.action.${e.action}`)}
                  {e.newPrices ? ` ${t('import.newPrices', { count: e.newPrices })}` : ''}
                </Pill>
              ) : e.ok ? (
                <Pill tone="green">{t('import.ready')}</Pill>
              ) : (
                <Pill tone="red">{t('import.cannot')}</Pill>
              )}
              <div className="small-text">{e.summary ?? e.reason}</div>
              {countedLines([...e.warnings, ...e.detail]).map((w) => (
                <div key={w.text} className="small-text muted">
                  {w.text}
                  {w.count > 1 ? ` (×${String(w.count)})` : ''}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
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
