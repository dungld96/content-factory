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

import { LocalTime } from '@/components/local-time';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { actionLabel, changeSummary, keyStatus, routeReadiness } from '@/lib/ai-settings-view';
import { errorText, mutate } from '@/lib/api-client';
import type { Tone } from '@/lib/content-status';
import { compactCount, priceLine, primaryPrices, sortPrices } from '@/lib/price-format';

/**
 * AI settings (P1 design O7), split into focused panels: providers, task routes, the model
 * catalogue and the change log. Everyone reads; operators (OPERATOR_EMAILS) change status and
 * routes and test credentials. Keys are never entered or shown here.
 */

const TASKS: Readonly<
  Record<AiTask, { readonly label: string; readonly hint: string; readonly capability: Capability }>
> = {
  script_generation: {
    label: 'Scripts',
    hint: 'Writes the script from the brief',
    capability: 'llm',
  },
  storyboard_generation: {
    label: 'Storyboards',
    hint: 'Splits the script into scenes',
    capability: 'llm',
  },
  image_generation: {
    label: 'Keyframes',
    hint: 'One image per scene',
    capability: 'image_generation',
  },
  video_generation: {
    label: 'Clips',
    hint: 'Animates each keyframe',
    capability: 'video_generation',
  },
  tts_generation: {
    label: 'Voice-overs',
    hint: 'Default; voice profiles choose their own',
    capability: 'tts',
  },
};

type Capability = AiModelDto['capabilities'][number];

const CAPABILITIES: readonly { readonly id: Capability; readonly label: string }[] = [
  { id: 'llm', label: 'Text' },
  { id: 'image_generation', label: 'Images' },
  { id: 'video_generation', label: 'Video' },
  { id: 'tts', label: 'Speech' },
];

const STATUS_TONE: Readonly<Record<AiProviderDto['status'], Tone>> = {
  enabled: 'green',
  disabled: 'gray',
  degraded: 'amber',
};
const STATUS_LABEL: Readonly<Record<AiProviderDto['status'], string>> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  degraded: 'Degraded',
};
const KIND_LABEL: Readonly<Record<AiProviderDto['kind'], string>> = {
  gateway: 'Gateway',
  direct: 'Direct',
  mock: 'Test provider',
};
const CHECK: Readonly<
  Record<AiProviderKeyCheckDto['result'], { readonly text: string; readonly tone: Tone }>
> = {
  valid: { text: 'Key accepted', tone: 'green' },
  rejected: { text: 'Key rejected — replace it in the server environment', tone: 'red' },
  unreachable: { text: 'Provider unreachable — try again later', tone: 'amber' },
  not_configured: { text: 'No key configured in this deployment', tone: 'gray' },
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
  const { busy, error, run } = useAction();
  const [checks, setChecks] = useState<Record<string, AiProviderKeyCheckDto>>({});
  return (
    <section className="card card-pad" aria-labelledby="ai-providers">
      <div className="section-head">
        <div>
          <h3 id="ai-providers">Providers</h3>
          <p>
            API keys live in the server environment, never in the browser. To change a key, an
            operator edits the environment file and restarts the API and worker.
          </p>
        </div>
      </div>
      <ul className="provider-grid" aria-label="Providers">
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
                <span className="tag">{KIND_LABEL[p.kind]}</span>
              </div>
              <dl className="provider-facts">
                <dt>Status</dt>
                <dd>
                  <Pill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Pill>
                </dd>
                <dt>Credentials</dt>
                <dd>
                  <Pill tone={key.ok ? 'green' : 'gray'}>{key.label}</Pill>
                </dd>
                {(p.termsUrl ?? p.dataPolicyUrl) && (
                  <>
                    <dt>Terms</dt>
                    <dd className="small-text">
                      {p.termsUrl && (
                        <a href={p.termsUrl} target="_blank" rel="noreferrer">
                          Terms
                        </a>
                      )}
                      {p.termsUrl && p.dataPolicyUrl && ' · '}
                      {p.dataPolicyUrl && (
                        <a href={p.dataPolicyUrl} target="_blank" rel="noreferrer">
                          Data policy
                        </a>
                      )}
                    </dd>
                  </>
                )}
              </dl>
              {check && (
                <div className="provider-check" role="status">
                  <Pill tone={CHECK[check.result].tone}>{CHECK[check.result].text}</Pill>
                  <span className="muted small-text">
                    {check.limitRemaining !== null
                      ? `Remaining limit ${String(check.limitRemaining)} · `
                      : ''}
                    {check.usage !== null ? `Usage ${String(check.usage)} · ` : ''}
                    {check.isFreeTier === true ? 'Free tier · ' : ''}
                    checked <LocalTime iso={check.checkedAt} />
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
                      {busy === `test-${p.key}` ? 'Testing…' : 'Test connection'}
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
                        `${p.name} ${p.status === 'enabled' ? 'disabled' : 'enabled'}.`,
                      )
                    }
                  >
                    {p.status === 'enabled' ? 'Disable' : 'Enable'}
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
  const { busy, error, run } = useAction();
  return (
    <section className="card card-pad" aria-labelledby="ai-routes">
      <div className="section-head">
        <div>
          <h3 id="ai-routes">Task routes</h3>
          <p>
            The model each production step uses by default. A change applies to new requests; queued
            jobs keep their model.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table routes-table stack-mobile" aria-label="Task routes">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Model</th>
              <th scope="col">Provider</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {props.routes.map((r) => {
              const task = TASKS[r.task];
              const readiness = routeReadiness(r, props.providers);
              const eligible = props.models.filter((m) => m.capabilities.includes(task.capability));
              const provider = props.providers.find((p) => p.key === r.provider?.key);
              return (
                <tr key={r.task}>
                  <td>
                    <div className="cell-title">{task.label}</div>
                    <div className="cell-sub">{task.hint}</div>
                  </td>
                  <td data-label="Model">
                    {props.isOperator ? (
                      <select
                        className="compact-select"
                        aria-label={`Model for ${task.label}`}
                        value={r.model?.modelKey ?? ''}
                        disabled={busy !== null}
                        onChange={(e) => {
                          if (e.target.value) {
                            void run(
                              r.task,
                              'PUT',
                              `/ai/routes/${r.task}`,
                              { modelKey: e.target.value },
                              `${task.label} now use ${e.target.value}.`,
                            );
                          }
                        }}
                      >
                        {!r.model && <option value="">Choose a model…</option>}
                        {r.model && !eligible.some((m) => m.modelKey === r.model?.modelKey) && (
                          <option value={r.model.modelKey}>
                            {r.model.displayName} (current, cannot run)
                          </option>
                        )}
                        {eligible.map((m) => (
                          <option key={m.id} value={m.modelKey}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    ) : r.model ? (
                      <>
                        <div className="cell-title">{r.model.displayName}</div>
                        <div className="cell-sub mono">{r.model.modelKey}</div>
                      </>
                    ) : (
                      <span className="muted">Not routed</span>
                    )}
                    {props.isOperator && eligible.length === 0 && (
                      <div className="cell-sub">No usable model with this capability yet.</div>
                    )}
                  </td>
                  <td data-label="Provider">
                    {provider ? provider.name : <span className="muted">—</span>}
                  </td>
                  <td data-label="Status">
                    {readiness.ready ? (
                      <Pill tone="green">Ready</Pill>
                    ) : (
                      <Pill tone="amber">{readiness.reason}</Pill>
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

function limits(m: AiModelDto): string {
  const parts: string[] = [];
  if (m.contextLength) parts.push(`${compactCount(m.contextLength)} context`);
  if (m.maxOutputTokens) parts.push(`${compactCount(m.maxOutputTokens)} output`);
  if (m.voices) parts.push(`${String(m.voices.length)} voices`);
  return parts.join(' · ') || '—';
}

export function ModelsPanel(props: {
  readonly models: readonly AiModelDto[];
  readonly providers: readonly AiProviderDto[];
  readonly isOperator: boolean;
}) {
  const { busy, error, run } = useAction();
  const [capability, setCapability] = useState<Capability>('llm');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(
    () =>
      Object.fromEntries(
        CAPABILITIES.map((c) => [
          c.id,
          props.models.filter((m) => m.capabilities.includes(c.id)).length,
        ]),
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
          <h3 id="ai-models">Model catalogue</h3>
          <p>
            Prices are the provider’s published prices in USD. New models start disabled; enable one
            only after a benchmark and a terms review.
          </p>
        </div>
      </div>
      <div className="catalogue-toolbar">
        <div className="segmented" role="tablist" aria-label="Capability">
          {CAPABILITIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={capability === c.id}
              onClick={() => {
                setCapability(c.id);
              }}
            >
              {c.label} <span className="chip-count">{counts[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="catalogue-filters">
          <input
            className="filter"
            type="search"
            placeholder="Search models…"
            aria-label="Search models"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
          <select
            className="compact-select"
            aria-label="Status"
            value={status}
            onChange={(e) => {
              const v = e.target.value;
              setStatus(v === 'enabled' || v === 'disabled' ? v : 'all');
            }}
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">No models match.</div>
      ) : (
        <div className="table-wrap">
          <table className="table stack-mobile" aria-label="Models">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Limits</th>
                <th scope="col">Price</th>
                <th scope="col">Status</th>
                {props.isOperator && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
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
                    <td data-label="Limits" className="small-text">
                      {limits(m)}
                    </td>
                    <td data-label="Price">
                      {m.activePrices.length === 0 ? (
                        <span className="muted small-text">Unknown (never shown as $0)</span>
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
                              <summary>All prices ({m.activePrices.length})</summary>
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
                                Source: {m.activePrices[0]?.source.replace('_', ' ')}, effective{' '}
                                {m.activePrices[0]?.effectiveFrom.slice(0, 10)}
                              </div>
                            </details>
                          )}
                        </>
                      )}
                    </td>
                    <td data-label="Status">
                      <Pill tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Pill>
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
                                `${m.displayName} ${m.status === 'enabled' ? 'disabled' : 'enabled'}.`,
                              )
                            }
                          >
                            {m.status === 'enabled' ? 'Disable' : 'Enable'}
                          </button>
                          {m.capabilities.includes('llm') && (
                            <select
                              className="compact-select"
                              aria-label={`Structured output for ${m.displayName}`}
                              title="Structured output: full schema, or basic for models that reject strict schemas"
                              value={m.schemaMode}
                              disabled={busy !== null}
                              onChange={(e) =>
                                void run(
                                  `${m.id}-schema`,
                                  'PATCH',
                                  `/ai/models/${m.id}`,
                                  { schemaMode: e.target.value },
                                  'Structured output mode saved.',
                                )
                              }
                            >
                              <option value="full">Schema: full</option>
                              <option value="basic">Schema: basic</option>
                            </select>
                          )}
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
  return (
    <section className="card card-pad" aria-labelledby="ai-events">
      <div className="section-head">
        <div>
          <h3 id="ai-events">Recent changes</h3>
          <p>The latest 50 changes, newest first. The log is append-only.</p>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="empty">No changes yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table stack-mobile" aria-label="Registry changes">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Change</th>
                <th scope="col">Target</th>
                <th scope="col">Value</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="small-text nowrap">
                    <LocalTime iso={e.createdAt} />
                  </td>
                  <td data-label="Change">{actionLabel(e.action)}</td>
                  <td data-label="Target" className="mono small-text">
                    {e.target}
                  </td>
                  <td data-label="Value" className="small-text">
                    {changeSummary(e)}
                  </td>
                  <td data-label="By" className="small-text">
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
