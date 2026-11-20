'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
import { errorText, mutate } from '@/lib/api-client';
import type { Tone } from '@/lib/content-status';
import { usableModels } from '@/lib/model-options';

const TASK_LABEL: Readonly<Record<AiTask, string>> = {
  script_generation: 'Scripts',
  storyboard_generation: 'Storyboards',
  image_generation: 'Keyframe images',
  video_generation: 'Clips',
  tts_generation: 'Voice-overs (default)',
};
const TASK_CAPABILITY: Readonly<Record<AiTask, AiModelDto['capabilities'][number]>> = {
  script_generation: 'llm',
  storyboard_generation: 'llm',
  image_generation: 'image_generation',
  video_generation: 'video_generation',
  tts_generation: 'tts',
};
const STATUS_TONE: Readonly<Record<AiProviderDto['status'], Tone>> = {
  enabled: 'green',
  disabled: 'gray',
  degraded: 'amber',
};
const CHECK_TEXT: Readonly<Record<AiProviderKeyCheckDto['result'], string>> = {
  valid: 'Key accepted',
  rejected: 'Key rejected: replace it in the server environment',
  unreachable: 'Provider unreachable',
  not_configured: 'No key configured in this deployment',
};

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    done?: string,
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await mutate<T>(method, path, body);
    setBusy(false);
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

/**
 * AI providers, routes and models (P1 design O7). Everyone reads; operators (OPERATOR_EMAILS)
 * change status and routes and test credentials. Keys are never entered or shown here: they live
 * in the server environment.
 */
export function AiSettings(props: {
  readonly providers: readonly AiProviderDto[];
  readonly routes: readonly AiRouteDto[];
  readonly models: readonly AiModelDto[];
  readonly events: readonly AiRegistryEventDto[];
  readonly isOperator: boolean;
}) {
  return (
    <>
      <ProvidersCard providers={props.providers} isOperator={props.isOperator} />
      <RoutesCard
        routes={props.routes}
        models={usableModels(props.models, props.providers)}
        isOperator={props.isOperator}
      />
      <ModelsCard models={props.models} isOperator={props.isOperator} />
      {props.isOperator && <EventsCard events={props.events} />}
    </>
  );
}

function ProvidersCard(props: {
  readonly providers: readonly AiProviderDto[];
  readonly isOperator: boolean;
}) {
  const { busy, error, run } = useAction();
  const [checks, setChecks] = useState<Record<string, AiProviderKeyCheckDto>>({});
  return (
    <section className="card card-pad" aria-labelledby="ai-providers">
      <div className="section-head">
        <div>
          <h2 id="ai-providers">AI providers</h2>
          <p>
            API keys live in the server environment, never in the browser. To change a key, an
            operator edits the environment file and restarts the API and worker.
          </p>
        </div>
      </div>
      <ul className="plain-list" aria-label="Providers">
        {props.providers.map((p) => {
          const check = checks[p.key];
          return (
            <li key={p.key}>
              <b>{p.name}</b> <code>{p.key}</code>{' '}
              <Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill>{' '}
              <Pill tone={p.configured ? 'green' : 'gray'}>
                {p.configured ? 'Key configured' : 'No key'}
              </Pill>
              {props.isOperator && (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void run<AiProviderKeyCheckDto>(
                        'POST',
                        `/ai/providers/${p.key}/test`,
                        {},
                      ).then((c) => {
                        if (c) setChecks((prev) => ({ ...prev, [p.key]: c }));
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        'PATCH',
                        `/ai/providers/${p.key}`,
                        { status: p.status === 'enabled' ? 'disabled' : 'enabled' },
                        `${p.name} ${p.status === 'enabled' ? 'disabled' : 'enabled'}.`,
                      )
                    }
                  >
                    {p.status === 'enabled' ? 'Disable' : 'Enable'}
                  </button>
                </>
              )}
              {check && (
                <div className="small-text" role="status">
                  {CHECK_TEXT[check.result]}
                  {check.limitRemaining !== null
                    ? ` · remaining limit ${String(check.limitRemaining)}`
                    : ''}
                  {check.usage !== null ? ` · usage ${String(check.usage)}` : ''}
                  {check.isFreeTier === true ? ' · free tier' : ''} ·{' '}
                  <LocalTime iso={check.checkedAt} />
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

function RoutesCard(props: {
  readonly routes: readonly AiRouteDto[];
  readonly models: readonly AiModelDto[];
  readonly isOperator: boolean;
}) {
  const { busy, error, run } = useAction();
  return (
    <section className="card card-pad" aria-labelledby="ai-routes">
      <div className="section-head">
        <div>
          <h2 id="ai-routes">Task routes</h2>
          <p>
            The model each step uses by default. A change applies to new requests; queued jobs keep
            their model. Voice-overs use the content’s voice profile.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table" aria-label="Task routes">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Model</th>
              <th scope="col">Provider</th>
            </tr>
          </thead>
          <tbody>
            {props.routes.map((r) => {
              const eligible = props.models.filter((m) =>
                m.capabilities.includes(TASK_CAPABILITY[r.task]),
              );
              return (
                <tr key={r.task}>
                  <td>{TASK_LABEL[r.task]}</td>
                  <td>
                    {props.isOperator ? (
                      <select
                        aria-label={`Model for ${TASK_LABEL[r.task]}`}
                        value={r.model?.modelKey ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          if (e.target.value) {
                            void run(
                              'PUT',
                              `/ai/routes/${r.task}`,
                              { modelKey: e.target.value },
                              `${TASK_LABEL[r.task]} now use ${e.target.value}.`,
                            );
                          }
                        }}
                      >
                        {!r.model && <option value="">Not routed</option>}
                        {r.model && !eligible.some((m) => m.modelKey === r.model?.modelKey) && (
                          <option value={r.model.modelKey}>
                            {r.model.displayName} (not usable)
                          </option>
                        )}
                        {eligible.map((m) => (
                          <option key={m.id} value={m.modelKey}>
                            {m.displayName} ({m.modelKey})
                          </option>
                        ))}
                      </select>
                    ) : r.model ? (
                      <>
                        {r.model.displayName} <code>{r.model.modelKey}</code>
                      </>
                    ) : (
                      'Not routed'
                    )}
                  </td>
                  <td>
                    {r.provider ? (
                      <>
                        <code>{r.provider.key}</code>{' '}
                        <Pill tone={r.provider.configured ? STATUS_TONE[r.provider.status] : 'red'}>
                          {r.provider.configured ? r.provider.status : 'no key'}
                        </Pill>
                      </>
                    ) : (
                      '—'
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

type Capability = AiModelDto['capabilities'][number];

const CAPABILITY_LABEL: Readonly<Partial<Record<Capability, string>>> = {
  llm: 'Text',
  image_generation: 'Images',
  video_generation: 'Video',
  tts: 'Speech',
};

const CAPABILITY_KEYS = Object.keys(CAPABILITY_LABEL) as Capability[];

function ModelsCard(props: {
  readonly models: readonly AiModelDto[];
  readonly isOperator: boolean;
}) {
  const { busy, error, run } = useAction();
  const [capability, setCapability] = useState<Capability>('llm');
  const shown = props.models.filter((m) => m.capabilities.includes(capability));
  return (
    <section className="card card-pad" aria-labelledby="ai-models">
      <div className="section-head">
        <div>
          <h2 id="ai-models">Models</h2>
          <p>
            Registered models with their recorded limits and prices (USD per unit, from the
            provider’s catalog). New models start disabled; enable one only after a benchmark and a
            terms review.
          </p>
        </div>
        <label className="field">
          Capability
          <select
            value={capability}
            onChange={(e) => {
              const next = CAPABILITY_KEYS.find((c) => c === e.target.value);
              if (next) setCapability(next);
            }}
          >
            {Object.entries(CAPABILITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted small-text">No models with this capability.</p>
      ) : (
        <ul className="plain-list" aria-label="Models">
          {shown.map((m) => (
            <li key={m.id} className="job-row">
              <b>{m.displayName}</b> <code>{m.modelKey}</code>{' '}
              <Pill tone={STATUS_TONE[m.status]}>{m.status}</Pill> · {m.qualityTier}
              {m.voices ? ` · ${String(m.voices.length)} voices` : ''}
              {m.contextLength ? ` · context ${String(m.contextLength)}` : ''}
              {props.isOperator && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      'PATCH',
                      `/ai/models/${m.id}`,
                      { status: m.status === 'enabled' ? 'disabled' : 'enabled' },
                      `${m.displayName} ${m.status === 'enabled' ? 'disabled' : 'enabled'}.`,
                    )
                  }
                >
                  {m.status === 'enabled' ? 'Disable' : 'Enable'}
                </button>
              )}
              {props.isOperator && m.capabilities.includes('llm') && (
                <label className="field">
                  Schema
                  <select
                    value={m.schemaMode}
                    disabled={busy}
                    onChange={(e) =>
                      void run(
                        'PATCH',
                        `/ai/models/${m.id}`,
                        { schemaMode: e.target.value },
                        'Saved.',
                      )
                    }
                  >
                    <option value="full">full</option>
                    <option value="basic">basic</option>
                  </select>
                </label>
              )}
              <div className="muted small-text">
                {m.activePrices.length === 0
                  ? 'No price recorded: cost unknown (never shown as 0)'
                  : m.activePrices
                      .map(
                        (p) =>
                          `${p.metric}: ${p.unitPriceUsd} (${p.source}, ${p.effectiveFrom.slice(0, 10)})`,
                      )
                      .join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

function EventsCard({ events }: { readonly events: readonly AiRegistryEventDto[] }) {
  return (
    <section className="card card-pad" aria-labelledby="ai-events">
      <div className="section-head">
        <div>
          <h2 id="ai-events">Recent registry changes</h2>
          <p>Every change from Settings or the operator CLI.</p>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="muted small-text">No changes yet.</p>
      ) : (
        <ul className="plain-list" aria-label="Registry changes">
          {events.map((e) => (
            <li key={e.id} className="small-text">
              <LocalTime iso={e.createdAt} /> · {e.action} · <code>{e.target}</code> ·{' '}
              {e.actor ? e.actor.displayName : 'CLI'}
              {e.after ? ` → ${JSON.stringify(e.after)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
