'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AiProviderDto, AiTask, SwitchAiGatewayResponseDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';

/** Sentinel for "keep this step where it is" in a step's model picker. */
const KEEP = '';

/**
 * Switch gateway (P5 decision G6, operators): pick a gateway, preview the equivalent model for
 * every step, adjust any step, then apply all routes at once. Steps without a routable model on
 * that gateway, or whose route needs zero-data-retention it cannot provide, stay where they are.
 */
export function GatewaySwitchPanel(props: { readonly providers: readonly AiProviderDto[] }) {
  const t = useT();
  const router = useRouter();
  const gateways = props.providers.filter((p) => p.kind === 'gateway');
  const [target, setTarget] = useState(gateways[0]?.key ?? '');
  const [plan, setPlan] = useState<SwitchAiGatewayResponseDto | null>(null);
  const [choices, setChoices] = useState<Partial<Record<AiTask, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (gateways.length < 2) return null;
  const gateway = gateways.find((g) => g.key === target);

  async function send(apply: boolean) {
    setBusy(true);
    setError(null);
    const r = await mutate<SwitchAiGatewayResponseDto>('POST', `/ai/gateways/${target}/switch`, {
      apply,
      ...(apply ? { choices } : {}),
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(errorText(r));
      return;
    }
    if (apply) {
      const moved = r.data.tasks.filter((x) => x.action === 'switched').length;
      toast(t('gw.done', { count: moved, name: gateway?.name ?? target }));
      setPlan(null);
      setChoices({});
      router.refresh();
      return;
    }
    setPlan(r.data);
    setChoices(Object.fromEntries(r.data.tasks.map((x) => [x.task, x.target?.modelKey ?? null])));
  }

  const moving = plan
    ? plan.tasks.filter((x) => x.candidates.length > 0 && (choices[x.task] ?? null) !== null).length
    : 0;

  return (
    <section className="card card-pad" aria-labelledby="ai-gateway">
      <div className="section-head">
        <div>
          <h3 id="ai-gateway">{t('gw.title')}</h3>
          <p>{t('gw.hint')}</p>
        </div>
      </div>
      <div className="row wrap">
        <label className="field">
          {t('gw.target')}
          <select
            className="compact-select"
            value={target}
            disabled={busy}
            onChange={(e) => {
              setTarget(e.target.value);
              setPlan(null);
              setChoices({});
            }}
          >
            {gateways.map((g) => (
              <option key={g.key} value={g.key}>
                {g.name}
                {g.status !== 'enabled' || !g.configured ? ` (${t('gw.notReady')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy || !target}
          onClick={() => void send(false)}
        >
          <Icon name="eye" /> {t('gw.preview')}
        </button>
      </div>
      {gateway && (gateway.status !== 'enabled' || !gateway.configured) && (
        <p className="notice" role="note">
          {t('gw.notReadyText', { name: gateway.name })}
        </p>
      )}
      {plan && (
        <>
          <div className="table-wrap">
            <table className="table stack-mobile" aria-label={t('gw.planLabel')}>
              <thead>
                <tr>
                  <th scope="col">{t('ai.colStep')}</th>
                  <th scope="col">{t('gw.now')}</th>
                  <th scope="col">{t('gw.after', { name: gateway?.name ?? target })}</th>
                </tr>
              </thead>
              <tbody>
                {plan.tasks.map((x) => {
                  const label = t(`ai.task.${x.task}`);
                  const chosen = choices[x.task] ?? null;
                  return (
                    <tr key={x.task}>
                      <td>
                        <div className="cell-title">{label}</div>
                      </td>
                      <td data-label={t('gw.now')}>
                        {x.current ? (
                          <>
                            <div className="cell-title">{x.current.displayName}</div>
                            <div className="cell-sub mono">
                              {x.current.providerKey} · {x.current.modelKey}
                            </div>
                          </>
                        ) : (
                          <span className="muted">{t('ai.notRouted')}</span>
                        )}
                      </td>
                      <td data-label={t('gw.after', { name: gateway?.name ?? target })}>
                        {x.candidates.length === 0 || x.keptBecause === 'zdr_required' ? (
                          <Pill tone="gray">{t(`gw.kept.${x.keptBecause ?? 'no_candidate'}`)}</Pill>
                        ) : (
                          <select
                            className="compact-select"
                            aria-label={t('ai.modelFor', { task: label })}
                            value={chosen ?? KEEP}
                            disabled={busy}
                            onChange={(e) => {
                              const v = e.target.value;
                              setChoices((prev) => ({ ...prev, [x.task]: v === KEEP ? null : v }));
                            }}
                          >
                            <option value={KEEP}>
                              {x.keptBecause === 'already_on_gateway'
                                ? t('gw.kept.already_on_gateway')
                                : t('gw.keep')}
                            </option>
                            {x.candidates.map((c) => (
                              <option key={c.modelKey} value={c.modelKey}>
                                {c.displayName}
                              </option>
                            ))}
                          </select>
                        )}
                        {x.keptBecause === 'not_chosen' && chosen === null && (
                          <div className="cell-sub">{t('gw.kept.not_chosen')}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small-text">{t('gw.costNote')}</p>
          <div className="row">
            <span className="spacer" />
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPlan(null);
                setChoices({});
              }}
            >
              {t('import.discard')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || moving === 0}
              onClick={() => void send(true)}
            >
              {t('gw.apply', { count: moving })}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
