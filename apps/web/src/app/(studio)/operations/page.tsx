import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { OpsSummaryDto } from '@acf/contracts';

import { Icon, type IconName } from '@/components/icon';
import { JobErrorLine } from '@/components/job-error';
import { LocalTime } from '@/components/local-time';
import { ResumeRunButton } from '@/components/resume-run';
import { Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { jobKindLabel } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { formatUsd } from '@/lib/money';

import { ReservationActions } from './reservation-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('ops.pageTitle') };
}

/** What each BullMQ queue carries (UX review U6). */
const QUEUE_LABEL: Readonly<Record<string, MessageKey>> = {
  generation: 'queue.generation',
  'generation-images': 'queue.images',
  'generation-video': 'queue.video',
  'generation-audio': 'queue.audio',
  'generation-render': 'queue.render',
  'generation-dlq': 'queue.dlq',
};

const CIRCUIT_TONE = { closed: 'green', half_open: 'amber', open: 'red' } as const;

type Health = 'ok' | 'warn' | 'bad';

function HealthTile(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly health: Health;
}) {
  return (
    <div className={`health-tile ${props.health}`}>
      <span className="health-icon" aria-hidden="true">
        <Icon name={props.health === 'ok' ? 'check' : props.health === 'warn' ? 'warning' : 'failed'} />
      </span>
      <span>
        <b>
          <Icon name={props.icon} size={14} /> {props.label}
        </b>
        <span>{props.value}</span>
      </span>
    </div>
  );
}

/**
 * Operations (M7 design §8, B8; redesign R6): a health strip first, then failures with Resume,
 * held reservations, queues (collapsed when idle), provider circuits and budgets. Project data
 * comes only from the caller's projects.
 */
export default async function OperationsPage() {
  const [summary, t] = await Promise.all([apiGet<OpsSummaryDto>('/ops/summary'), getT()]);
  if (summary.kind === 'unauthenticated') redirect('/login');
  if (summary.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('ops.loadError')}
      </section>
    );
  }
  const s = summary.data;
  const failed24h = s.jobs24h.filter((j) => j.status === 'failed').reduce((n, j) => n + j.count, 0);
  const done24h = s.jobs24h
    .filter((j) => j.status === 'succeeded')
    .reduce((n, j) => n + j.count, 0);
  const openCircuits = s.circuits.filter((c) => c.state !== 'closed');
  const queuedNow = (s.queues ?? []).reduce((n, q) => n + q.waiting + q.active + q.delayed, 0);
  const queuesBusy = s.queues === null || queuedNow > 0 || s.queues.some((q) => q.failed > 0);
  const warnBudgets = s.budgets.filter((b) => b.warning).length;

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('ops.eyebrow')}</div>
          <h1>{t('ops.title')}</h1>
          <p>
            {t('ops.lead')} <LocalTime iso={s.generatedAt} />.
          </p>
        </div>
      </div>

      <section className="health-strip" aria-label={t('ops.health')}>
        <HealthTile
          icon="operations"
          label={t('ops.health.queues')}
          health={s.queues === null ? 'bad' : queuedNow > 0 ? 'warn' : 'ok'}
          value={
            s.queues === null
              ? t('ops.health.queuesDown')
              : queuedNow > 0
                ? t('ops.health.queuesBusy', { count: queuedNow })
                : t('ops.health.queuesOk')
          }
        />
        <HealthTile
          icon="generate"
          label={t('ops.health.providers')}
          health={openCircuits.length > 0 ? 'bad' : 'ok'}
          value={
            openCircuits.length > 0
              ? t('ops.health.providersDown', { count: openCircuits.length })
              : t('ops.health.providersOk')
          }
        />
        <HealthTile
          icon="costs"
          label={t('ops.health.budgets')}
          health={warnBudgets > 0 ? 'warn' : 'ok'}
          value={
            warnBudgets > 0
              ? t('ops.health.budgetsWarn', { count: warnBudgets })
              : t('ops.health.budgetsOk')
          }
        />
        <HealthTile
          icon="warning"
          label={t('ops.health.failures')}
          health={failed24h > 0 ? 'bad' : 'ok'}
          value={String(failed24h)}
        />
      </section>

      {openCircuits.length > 0 && (
        <p className="notice" role="status">
          {t('ops.circuitNotice', {
            providers: openCircuits.map((c) => c.providerName).join(', '),
          })}
        </p>
      )}

      <section className="stats" aria-label={t('ops.last24')}>
        <div className="card stat">
          <div className="stat-top">{t('ops.succeeded')}</div>
          <div className="stat-value">{done24h}</div>
          <div className="stat-foot">{t('ops.succeededFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('ops.failed')}</div>
          <div className="stat-value">{failed24h}</div>
          <div className="stat-foot">{t('ops.failedFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('ops.held')}</div>
          <div className="stat-value">{s.heldReservations.length}</div>
          <div className="stat-foot">{t('ops.heldFoot')}</div>
        </div>
      </section>

      <section className="card card-pad">
        <h2>{t('ops.failedJobs')}</h2>
        {s.failedJobs.length === 0 ? (
          <p className="muted small-text">{t('ops.noFailed')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label={t('ops.failedJobs')}>
              <thead>
                <tr>
                  <th scope="col">{t('ops.colContent')}</th>
                  <th scope="col">{t('ops.colStage')}</th>
                  <th scope="col">{t('ops.colError')}</th>
                  <th scope="col">{t('ops.colFailed')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('ops.colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.failedJobs.map((j) => (
                  <tr key={j.jobId}>
                    <td>
                      <Link href={`/content/${j.contentItemId}`}>{j.contentTitle}</Link>
                      <br />
                      <span className="muted small-text">{j.projectName}</span>
                    </td>
                    <td>{jobKindLabel(t, j.kind)}</td>
                    <td>
                      {j.errorCode ? (
                        <JobErrorLine code={j.errorCode} message={j.errorMessage} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <LocalTime iso={j.failedAt} />
                    </td>
                    <td>
                      <ResumeRunButton runId={j.productionRunId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad">
        <h2>{t('ops.heldTitle')}</h2>
        <p className="muted small-text">{t('ops.heldHint')}</p>
        {s.heldReservations.length === 0 ? (
          <p className="muted small-text">{t('ops.nothingToResolve')}</p>
        ) : (
          <ul className="plain-list" aria-label={t('ops.heldTitle')}>
            {s.heldReservations.map((r) => (
              <li key={r.id}>
                <b>{formatUsd(r.amountUsd)}</b> · {t('ops.heldOf', { kind: jobKindLabel(t, r.jobKind) })}{' '}
                <Link href={`/content/${r.contentItemId}`}>{r.contentTitle}</Link> ({r.projectName})
                {r.jobErrorCode ? ` · ${r.jobErrorCode}` : ''} · <LocalTime iso={r.createdAt} />{' '}
                {r.canResolve ? (
                  <ReservationActions reservationId={r.id} label={formatUsd(r.amountUsd)} />
                ) : (
                  <span className="muted small-text">{t('ops.ownerResolves')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <details open={queuesBusy}>
          <summary>
            <h2 className="inline-heading">{t('ops.queues')}</h2>{' '}
            <span className="muted small-text">
              {s.queues === null
                ? t('ops.queuesDown')
                : queuesBusy
                  ? t('ops.queuesBusy', { count: queuedNow })
                  : t('ops.queuesIdle')}
            </span>
          </summary>
          {s.queues === null ? (
            <p className="notice error" role="alert">
              {t('ops.queuesDownBody')}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label={t('ops.queues')}>
                <thead>
                  <tr>
                    <th scope="col">{t('ops.colQueue')}</th>
                    <th scope="col">{t('ops.colWaiting')}</th>
                    <th scope="col">{t('ops.colActive')}</th>
                    <th scope="col">{t('ops.colDelayed')}</th>
                    <th scope="col">{t('ops.colDead')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.queues.map((q) => {
                    const label = QUEUE_LABEL[q.queue];
                    return (
                      <tr key={q.queue}>
                        <td>
                          {label ? t(label) : q.queue}
                          <br />
                          <code className="muted small-text">{q.queue}</code>
                        </td>
                        <td>{q.waiting}</td>
                        <td>{q.active}</td>
                        <td>{q.delayed}</td>
                        <td>{q.failed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>
      <section className="card card-pad">
        <h2>{t('ops.providers')}</h2>
        {s.circuits.length === 0 ? (
          <p className="muted small-text">{t('ops.noProviderFailures')}</p>
        ) : (
          <ul className="plain-list" aria-label={t('ops.circuitsLabel')}>
            {s.circuits.map((c) => (
              <li key={c.providerKey}>
                <Pill tone={CIRCUIT_TONE[c.state]}>{t(`circuit.${c.state}`)}</Pill> {c.providerName}
                {c.consecutiveFailures > 0
                  ? ` ${t('ops.failuresInRow', { count: c.consecutiveFailures })}`
                  : ''}
                {c.lastErrorCode ? ` ${t('ops.lastError', { code: c.lastErrorCode })}` : ''}
                {c.retryAt && c.state === 'open' && (
                  <>
                    {' '}
                    {t('ops.retriesAfter')} <LocalTime iso={c.retryAt} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <h2>{t('ops.budgets')}</h2>
        {s.budgets.length === 0 ? (
          <p className="muted small-text">{t('ops.noMembership')}</p>
        ) : (
          <ul className="plain-list" aria-label={t('ops.budgetsLabel')}>
            {s.budgets.map((b) => (
              <li key={b.projectId}>
                <Link href={`/projects/${b.projectId}/costs`}>{b.projectName}</Link>:{' '}
                {t('ops.budgetLine', { used: formatUsd(b.usedUsd), limit: formatUsd(b.limitUsd) })}
                {b.heldUsd !== '0' ? ` ${t('ops.heldAmount', { amount: formatUsd(b.heldUsd) })}` : ''}{' '}
                {b.warning && <Pill tone="amber">{t('costs.warning80')}</Pill>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
