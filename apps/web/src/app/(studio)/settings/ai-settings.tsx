'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type {
  AiModelDto,
  AiProviderDto,
  AiProviderKeyCheckDto,
  AiRegistryEventDto,
  AiRouteDto,
  AiTask,
} from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { LocalTime } from '@/components/local-time';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { actionLabel, changeSummary, keyStatus, routeReadiness } from '@/lib/ai-settings-view';
import { errorText, mutate } from '@/lib/api-client';
import type { Tone } from '@/lib/content-status';
import type { MessageKey, Translate } from '@/lib/i18n';
import { compactCount, priceLine, primaryPrices, sortPrices } from '@/lib/price-format';

import { AddPriceButton } from './model-admin';

/**
 * AI settings (P1 design O7), split into focused panels: providers, task routes, the model
 * catalogue and the change log. Everyone reads; operators (OPERATOR_EMAILS) change status and
 * routes and test credentials. Keys are never entered or shown here.
 */

type Capability = AiModelDto['capabilities'][number];

const TASK_CAPABILITY: Readonly<Record<AiTask, Capability>> = {
  script_generation: 'llm',
  storyboard_generation: 'llm',
  image_generation: 'image_generation',
  video_generation: 'video_generation',
  tts_generation: 'tts',
};

const CAPABILITIES = ['llm', 'image_generation', 'video_generation', 'tts'] as const;
type ShownCapability = (typeof CAPABILITIES)[number];

const STATUS_TONE: Readonly<Record<AiProviderDto['status'], Tone>> = {
  enabled: 'green',
  disabled: 'gray',
  degraded: 'amber',
};
const STATUS_LABEL = (s: AiProviderDto['status']): MessageKey => `ai.status.${s}`;
const CHECK_TONE: Readonly<Record<AiProviderKeyCheckDto['result'], Tone>> = {
  valid: 'green',
  rejected: 'red',
  unreachable: 'amber',
  not_configured: 'gray',
};

/** One request at a time per panel; errors shown inline; success refreshes the server data. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(
    id: string,
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    done?: string,
  ): Promise<T | null> {
    setBusy(id);
    setError(null);
    const r = await mutate<T>(method, path, body);
    setBusy(null);
    if (!r.ok) {
      setError(errorText(r));
      return null;
    }
    if (done) toast(done);
    router.refresh();
    return r.data;
  }
  return { busy, error, run };
}

function ErrorLine({ error }: { readonly error: string | null }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}

// ------------------------------------------------------------------------------- providers

export function ProvidersPanel(props: {
  readonly providers: readonly AiProviderDto[];
  readonly isOperator: boolean;
}) {
  const t = useT();
  const { busy, error, run } = useAction();
  const [checks, setChecks] = useState<Record<string, AiProviderKeyCheckDto>>({});
  return (
    <section className="card card-pad" aria-labelledby="ai-providers">
      <div className="section-head">
        <div>
          <h3 id="ai-providers">{t('ai.providers')}</h3>
          <p>{t('ai.providersHint')}</p>
        </div>
      </div>
      <ul className="provider-grid" aria-label={t('ai.providers')}>
        {props.providers.map((p) => {
          const key = keyStatus(p);
          const check = checks[p.key];
          return (
            <li key={p.key} className="provider-card">
              <div className="provider-head">
                <div>
                  <b>{p.name}</b>
                  <code>{p.key}</code>
                </div>
                <span className="tag">{t(`ai.kind.${p.kind}`)}</span>
              </div>
              <dl className="provider-facts">
                <dt>{t('ai.dt.status')}</dt>
                <dd>
                  <Pill tone={STATUS_TONE[p.status]}>{t(STATUS_LABEL(p.status))}</Pill>
                </dd>
                <dt>{t('ai.dt.credentials')}</dt>
                <dd>
                  <Pill tone={key.ok ? 'green' : 'gray'}>{t(key.label)}</Pill>
                </dd>
                {(p.termsUrl ?? p.dataPolicyUrl) && (
                  <>
                    <dt>{t('ai.dt.terms')}</dt>
                    <dd className="small-text">
                      {p.termsUrl && (
                        <a href={p.termsUrl} target="_blank" rel="noreferrer">
                          {t('ai.terms')}
                        </a>
                      )}
                      {p.termsUrl && p.dataPolicyUrl && ' · '}
                      {p.dataPolicyUrl && (
                        <a href={p.dataPolicyUrl} target="_blank" rel="noreferrer">
                          {t('ai.dataPolicy')}
                        </a>
                      )}
                    </dd>
                  </>
                )}
              </dl>
              {check && (
                <div className="provider-check" role="status">
                  <Pill tone={CHECK_TONE[check.result]}>{t(`ai.check.${check.result}`)}</Pill>
                  <span className="muted small-text">
                    {check.limitRemaining !== null
                      ? `${t('ai.remaining', { value: check.limitRemaining })} `
                      : ''}
                    {check.usage !== null ? `${t('ai.usage', { value: check.usage })} ` : ''}
                    {check.isFreeTier === true ? `${t('ai.freeTier')} ` : ''}
                    {t('ai.checked')} <LocalTime iso={check.checkedAt} />
                  </span>
                </div>
              )}
              {props.isOperator && (
                <div className="provider-actions">
                  {p.kind !== 'mock' && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null}
                      onClick={() =>
                        void run<AiProviderKeyCheckDto>(
                          `test-${p.key}`,
                          'POST',
                          `/ai/providers/${p.key}/test`,
                          {},
                        ).then((c) => {
                          if (c) setChecks((prev) => ({ ...prev, [p.key]: c }));
                        })
                      }
                    >
                      {busy === `test-${p.key}` ? t('ai.testing') : t('ai.test')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={p.status === 'enabled' ? 'btn ghost' : 'btn primary'}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `status-${p.key}`,
                        'PATCH',
                        `/ai/providers/${p.key}`,
                        { status: p.status === 'enabled' ? 'disabled' : 'enabled' },
                        t('ai.providerToggled', {
                          name: p.name,
                          state: t(
                            p.status === 'enabled' ? 'ai.status.disabled' : 'ai.status.enabled',
                          ),
                        }),
                      )
                    }
                  >
                    {p.status === 'enabled' ? t('ai.disable') : t('ai.enable')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorLine error={error} />
    </section>
  );
}

// ---------------------------------------------------------------------------------- routes

export function RoutesPanel(props: {
  readonly routes: readonly AiRouteDto[];
  readonly providers: readonly AiProviderDto[];
  /** Usable models only (enabled, provider enabled and configured). */
  readonly models: readonly AiModelDto[];
  readonly isOperator: boolean;
}) {
  const t = useT();
  const { busy, error, run } = useAction();
  const gatewayCount = new Set(props.models.map((m) => m.providerKey)).size;
  const providerName = (key: string) => props.providers.find((p) => p.key === key)?.name ?? key;
  return (
    <section className="card card-pad" aria-labelledby="ai-routes">
      <div className="section-head">
        <div>
          <h3 id="ai-routes">{t('ai.routes')}</h3>
          <p>{t('ai.routesHint')}</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table routes-table stack-mobile" aria-label={t('ai.routes')}>
          <thead>
            <tr>
              <th scope="col">{t('ai.colStep')}</th>
              <th scope="col">{t('ai.colModel')}</th>
              <th scope="col">{t('ai.colProvider')}</th>
              <th scope="col">{t('ai.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {props.routes.map((r) => {
              const capability = TASK_CAPABILITY[r.task];
              const label = t(`ai.task.${r.task}`);
              const readiness = routeReadiness(r, props.providers);
              const eligible = props.models.filter((m) => m.capabilities.includes(capability));
              const provider = props.providers.find((p) => p.key === r.provider?.key);
              return (
                <tr key={r.task}>
                  <td>
                    <div className="cell-title">{label}</div>
                    <div className="cell-sub">{t(`ai.task.${r.task}.hint`)}</div>
                  </td>
                  <td data-label={t('ai.colModel')}>
                    {props.isOperator ? (
                      <select
                        className="compact-select"
                        aria-label={t('ai.modelFor', { task: label })}
                        value={r.model?.id ?? ''}
                        disabled={busy !== null}
                        onChange={(e) => {
                          const picked = eligible.find((m) => m.id === e.target.value);
                          if (picked) {
                            // The provider disambiguates a key offered by several gateways (P5).
                            void run(
                              r.task,
                              'PUT',
                              `/ai/routes/${r.task}`,
                              { modelKey: picked.modelKey, providerKey: picked.providerKey },
                              t('ai.routed', { task: label, model: picked.displayName }),
                            );
                          }
                        }}
                      >
                        {!r.model && <option value="">{t('ai.chooseModel')}</option>}
                        {r.model && !eligible.some((m) => m.id === r.model?.id) && (
                          <option value={r.model.id}>
                            {t('ai.currentCannotRun', { name: r.model.displayName })}
                          </option>
                        )}
                        {eligible.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                            {gatewayCount > 1 ? ` · ${providerName(m.providerKey)}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : r.model ? (
                      <>
                        <div className="cell-title">{r.model.displayName}</div>
                        <div className="cell-sub mono">{r.model.modelKey}</div>
                      </>
                    ) : (
                      <span className="muted">{t('ai.notRouted')}</span>
                    )}
                    {props.isOperator && eligible.length === 0 && (
                      <div className="cell-sub">{t('ai.noEligible')}</div>
                    )}
                  </td>
                  <td data-label={t('ai.colProvider')}>
                    {provider ? provider.name : <span className="muted">—</span>}
                  </td>
                  <td data-label={t('ai.colStatus')}>
                    {readiness.ready ? (
                      <Pill tone="green">{t('ai.ready')}</Pill>
                    ) : (
                      <Pill tone="amber">{t(readiness.reason)}</Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorLine error={error} />
    </section>
  );
}

// ---------------------------------------------------------------------------------- models

function limits(t: Translate, m: AiModelDto): string {
  const parts: string[] = [];
  if (m.contextLength) parts.push(t('ai.limit.context', { value: compactCount(m.contextLength) }));
  if (m.maxOutputTokens)
    parts.push(t('ai.limit.output', { value: compactCount(m.maxOutputTokens) }));
  if (m.voices) parts.push(t('ai.limit.voices', { count: m.voices.length }));
  return parts.join(' · ') || '—';
}

export function ModelsPanel(props: {
  readonly models: readonly AiModelDto[];
  readonly providers: readonly AiProviderDto[];
  readonly isOperator: boolean;
}) {
  const t = useT();
  const { busy, error, run } = useAction();
  const [capability, setCapability] = useState<ShownCapability>('llm');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(
    () =>
      Object.fromEntries(
        CAPABILITIES.map((c) => [c, props.models.filter((m) => m.capabilities.includes(c)).length]),
      ),
    [props.models],
  );
  const needle = q.trim().toLowerCase();
  const shown = props.models.filter(
    (m) =>
      m.capabilities.includes(capability) &&
      (status === 'all' ||
        (status === 'enabled' ? m.status === 'enabled' : m.status !== 'enabled')) &&
      (!needle ||
        m.displayName.toLowerCase().includes(needle) ||
        m.modelKey.toLowerCase().includes(needle)),
  );
  const providerName = (key: string) => props.providers.find((p) => p.key === key)?.name ?? key;

  return (
    <section className="card card-pad" aria-labelledby="ai-models">
      <div className="section-head">
        <div>
          <h3 id="ai-models">{t('ai.catalogue')}</h3>
          <p>{t('ai.catalogueHint')}</p>
        </div>
      </div>
      <div className="catalogue-toolbar">
        <div className="segmented" role="tablist" aria-label={t('ai.capability')}>
          {CAPABILITIES.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={capability === c}
              onClick={() => {
                setCapability(c);
              }}
            >
              {t(`ai.cap.${c}`)} <span className="chip-count">{counts[c] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="catalogue-filters">
          <input
            className="filter"
            type="search"
            placeholder={t('ai.searchModels')}
            aria-label={t('ai.searchModels')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
          <select
            className="compact-select"
            aria-label={t('ai.colStatus')}
            value={status}
            onChange={(e) => {
              const v = e.target.value;
              setStatus(v === 'enabled' || v === 'disabled' ? v : 'all');
            }}
          >
            <option value="all">{t('ai.allStatuses')}</option>
            <option value="enabled">{t('ai.status.enabled')}</option>
            <option value="disabled">{t('ai.status.disabled')}</option>
          </select>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">{t('ai.noMatch')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table stack-mobile" aria-label={t('ai.models')}>
            <thead>
              <tr>
                <th scope="col">{t('ai.colModel')}</th>
                <th scope="col">{t('ai.colLimits')}</th>
                <th scope="col">{t('ai.colPrice')}</th>
                <th scope="col">{t('ai.colStatus')}</th>
                {props.isOperator && (
                  <th scope="col">
                    <span className="sr-only">{t('ai.colActions')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const main = primaryPrices(m.activePrices);
                const rest = m.activePrices.length - main.length;
                return (
                  <tr key={m.id}>
                    <td>
                      <div className="cell-title">{m.displayName}</div>
                      <div className="cell-sub mono">{m.modelKey}</div>
                      <div className="cell-sub">
                        {providerName(m.providerKey)} · {m.qualityTier}
                      </div>
                    </td>
                    <td data-label={t('ai.colLimits')} className="small-text">
                      {limits(t, m)}
                    </td>
                    <td data-label={t('ai.colPrice')}>
                      {m.activePrices.length === 0 ? (
                        <span className="muted small-text">{t('ai.priceUnknown')}</span>
                      ) : (
                        <>
                          <ul className="price-list">
                            {(main.length > 0
                              ? main
                              : sortPrices(m.activePrices).slice(0, 2).map(priceLine)
                            ).map((line) => (
                              <li key={line.id}>
                                <span>{line.label}</span> <b>{line.price}</b>
                              </li>
                            ))}
                          </ul>
                          {rest > 0 && (
                            <details className="price-more">
                              <summary>
                                {t('ai.allPrices', { count: m.activePrices.length })}
                              </summary>
                              <ul className="price-list">
                                {sortPrices(m.activePrices)
                                  .map(priceLine)
                                  .map((line) => (
                                    <li key={line.id}>
                                      <span>{line.label}</span> <b>{line.price}</b>
                                    </li>
                                  ))}
                              </ul>
                              <div className="cell-sub">
                                {t('ai.priceSource', {
                                  source: m.activePrices[0]?.source.replace('_', ' ') ?? '',
                                  date: m.activePrices[0]?.effectiveFrom.slice(0, 10) ?? '',
                                })}
                              </div>
                            </details>
                          )}
                        </>
                      )}
                    </td>
                    <td data-label={t('ai.colStatus')}>
                      <Pill tone={STATUS_TONE[m.status]}>{t(STATUS_LABEL(m.status))}</Pill>
                    </td>
                    {props.isOperator && (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className={m.status === 'enabled' ? 'btn small ghost' : 'btn small'}
                            disabled={busy !== null}
                            onClick={() =>
                              void run(
                                m.id,
                                'PATCH',
                                `/ai/models/${m.id}`,
                                { status: m.status === 'enabled' ? 'disabled' : 'enabled' },
                                t('ai.providerToggled', {
                                  name: m.displayName,
                                  state: t(
                                    m.status === 'enabled'
                                      ? 'ai.status.disabled'
                                      : 'ai.status.enabled',
                                  ),
                                }),
                              )
                            }
                          >
                            {m.status === 'enabled' ? t('ai.disable') : t('ai.enable')}
                          </button>
                          {m.capabilities.includes('llm') && (
                            <select
                              className="compact-select"
                              aria-label={t('ai.schemaFor', { name: m.displayName })}
                              title={t('ai.schemaTitle')}
                              value={m.schemaMode}
                              disabled={busy !== null}
                              onChange={(e) =>
                                void run(
                                  `${m.id}-schema`,
                                  'PATCH',
                                  `/ai/models/${m.id}`,
                                  { schemaMode: e.target.value },
                                  t('ai.schemaSaved'),
                                )
                              }
                            >
                              <option value="full">{t('ai.schemaFull')}</option>
                              <option value="basic">{t('ai.schemaBasic')}</option>
                            </select>
                          )}
                          <AddPriceButton model={m} />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

// ------------------------------------------------------------------------------ change log

export function ActivityPanel({ events }: { readonly events: readonly AiRegistryEventDto[] }) {
  const t = useT();
  return (
    <section className="card card-pad" aria-labelledby="ai-events">
      <div className="section-head">
        <div>
          <h3 id="ai-events">{t('ai.changes')}</h3>
          <p>{t('ai.changesHint')}</p>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="empty">{t('ai.noChanges')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table stack-mobile" aria-label={t('ai.changesLabel')}>
            <thead>
              <tr>
                <th scope="col">{t('ai.colWhen')}</th>
                <th scope="col">{t('ai.colChange')}</th>
                <th scope="col">{t('ai.colTarget')}</th>
                <th scope="col">{t('ai.colValue')}</th>
                <th scope="col">{t('ai.colBy')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="small-text nowrap">
                    <LocalTime iso={e.createdAt} />
                  </td>
                  <td data-label={t('ai.colChange')}>
                    {(() => {
                      const key = actionLabel(e.action);
                      return key ? t(key) : e.action;
                    })()}
                  </td>
                  <td data-label={t('ai.colTarget')} className="mono small-text">
                    {e.target}
                  </td>
                  <td data-label={t('ai.colValue')} className="small-text">
                    {changeSummary(e)}
                  </td>
                  <td data-label={t('ai.colBy')} className="small-text">
                    {e.actor ? e.actor.displayName : <span className="tag">CLI</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
