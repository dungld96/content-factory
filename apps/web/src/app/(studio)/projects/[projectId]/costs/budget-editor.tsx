'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import type { BudgetDto, UpdateBudgetRequest } from '@acf/contracts';

import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';

const SCOPES = [
  {
    key: 'monthly',
    label: 'Monthly',
    hint: 'UTC calendar month, all content of the project',
    optional: false,
  },
  { key: 'item', label: 'Per content item', hint: 'All work on one content item', optional: true },
  {
    key: 'request',
    label: 'Per request',
    hint: 'One generate click (all its scenes)',
    optional: true,
  },
] as const;
type ScopeKey = (typeof SCOPES)[number]['key'];

const USD = /^\d+(\.\d{1,6})?$/;

/**
 * Owner-only budget editor (M7 design §3, B1/B2): each limit is `hard` (blocks the request) or
 * `soft` (asks for confirmation; accepting is recorded). An empty optional limit means none.
 */
export function BudgetEditor({ budget }: { readonly budget: BudgetDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: ScopeKey) => {
      const limit = form.get(`${key}-limit`);
      return {
        raw: typeof limit === 'string' ? limit.trim() : '',
        mode: form.get(`${key}-mode`) === 'soft' ? ('soft' as const) : ('hard' as const),
      };
    };
    for (const scope of SCOPES) {
      const { raw } = read(scope.key);
      if (raw === '' && !scope.optional) {
        setError('The monthly limit is required (0 blocks all paid work).');
        return;
      }
      if (raw !== '' && !USD.test(raw)) {
        setError(`${scope.label}: enter an amount in USD, e.g. 2.50.`);
        return;
      }
    }
    const optional = (key: 'item' | 'request') => {
      const { raw, mode } = read(key);
      return { limitUsd: raw === '' ? null : raw, mode };
    };
    const request: UpdateBudgetRequest = {
      monthly: { limitUsd: read('monthly').raw, mode: read('monthly').mode },
      item: optional('item'),
      request: optional('request'),
    };
    setBusy(true);
    setError(null);
    const r = await mutate<BudgetDto>('PUT', `/projects/${budget.projectId}/budget`, request);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    toast('Budget saved.');
    router.refresh();
  }

  const current = (key: ScopeKey) => budget[key];
  return (
    <form
      className="card card-pad budget-editor"
      aria-label="Budget limits"
      onSubmit={(e) => void submit(e)}
    >
      <h2>Budget limits</h2>
      <p className="muted small-text">
        Hard limits block a request; soft limits ask for confirmation, and accepting is recorded.
        Work whose cost cannot be estimated reserves $0.50 per call.
      </p>
      {SCOPES.map((scope) => (
        <div className="form-row" key={scope.key}>
          <div className="field">
            <label htmlFor={`${scope.key}-limit`}>{scope.label} limit (USD)</label>
            <input
              id={`${scope.key}-limit`}
              name={`${scope.key}-limit`}
              inputMode="decimal"
              defaultValue={current(scope.key).limitUsd ?? ''}
              placeholder={scope.optional ? 'No limit' : undefined}
              aria-describedby={`${scope.key}-hint`}
            />
            <span id={`${scope.key}-hint`} className="muted small-text">
              {scope.hint}
            </span>
          </div>
          <div className="field">
            <label htmlFor={`${scope.key}-mode`}>{scope.label} mode</label>
            <select
              id={`${scope.key}-mode`}
              name={`${scope.key}-mode`}
              defaultValue={current(scope.key).mode}
            >
              <option value="hard">Hard (block)</option>
              <option value="soft">Soft (confirm)</option>
            </select>
          </div>
        </div>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          Save budget
        </button>
      </div>
    </form>
  );
}
