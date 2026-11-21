'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AiModelDto, ImportAiModelsResponseDto } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { countedLines } from '@/lib/format';

const CATALOGS = [
  { id: 'llm', label: 'Text (LLM)' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'tts', label: 'Speech (TTS)' },
] as const;

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
  const router = useRouter();
  const [catalog, setCatalog] = useState<(typeof CATALOGS)[number]['id']>('llm');
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
      toast('Import finished. New models are disabled until you enable them.');
      router.refresh();
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="ai-import">
      <div className="section-head">
        <div>
          <h3 id="ai-import">Import from OpenRouter</h3>
          <p>
            Reads the public catalog (no key, no cost). Preview first; importing creates disabled
            models and appends prices, never changing earlier ones.
          </p>
        </div>
      </div>
      <div className="import-form">
        <label className="field">
          Catalog
          <select
            value={catalog}
            onChange={(e) => {
              setCatalog(e.target.value as typeof catalog);
              setResult(null);
            }}
          >
            {CATALOGS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field import-keys">
          Model keys <small>(author/slug, one per line, up to 10)</small>
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
          Tier for new models
          <select
            value={tier}
            onChange={(e) => {
              setTier(e.target.value);
            }}
          >
            <option value="economy">Economy</option>
            <option value="balanced">Balanced</option>
            <option value="premium">Premium</option>
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
          Preview
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || result === null || result.applied || !result.entries.some((e) => e.ok)}
          onClick={() => void send(true)}
        >
          <Icon name="upload" /> Import
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <ul className="plain-list import-result" aria-label="Import preview">
          {result.entries.map((e) => (
            <li key={e.modelKey}>
              <b className="mono">{e.modelKey}</b>{' '}
              {e.action ? (
                <Pill tone={ACTION_TONE[e.action]}>
                  {e.action}
                  {e.newPrices ? ` · ${String(e.newPrices)} new price(s)` : ''}
                </Pill>
              ) : e.ok ? (
                <Pill tone="green">Ready</Pill>
              ) : (
                <Pill tone="red">Cannot import</Pill>
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
    toast('Price added.');
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
        Add price
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={`Add a price · ${model.displayName}`}
        description="USD per unit, as published. The new price applies from now; earlier prices stay in the history."
      >
        <div className="form">
          <label className="field">
            Metric
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
            USD per unit
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
            Source
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
            >
              <option value="official_page">Official pricing page</option>
              <option value="official_api">Official API</option>
              <option value="manual_estimate">Manual estimate</option>
            </select>
          </label>
          <label className="field">
            Source URL
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
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !/^\d+(\.\d+)?$/.test(usd.trim()) || !url.trim()}
              onClick={() => void save()}
            >
              Add price
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
