import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Icon, type IconName } from '@/components/icon';
import { JobErrorLine } from '@/components/job-error';
import { LocalTime } from '@/components/local-time';
import { ResumeRunButton } from '@/components/resume-run';
import { PageCrumbs } from '@/components/shell/page-crumbs';
import { Pill } from '@/components/status-pill';
import { loadOpsSummary } from '@/lib/ops-summary';
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

type Health = 'ok' | 'warn' | 'bad';

/**
 * Operations (M7 design §8, B8; redesign R6): a health strip first, then failures with Resume,
 * held reservations, queues (collapsed when idle), provider circuits and budgets. Project data
 * comes only from the caller's projects.
 */
export default async function OperationsPage() {
  const [summary, t] = await Promise.all([loadOpsSummary(), getT()]);
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

  const attention = s.failedJobs.length + s.heldReservations.length;
  const kinds = [...new Set(s.jobs24h.map((j) => j.kind))];
  const count24 = (status: string) =>
    s.jobs24h.filter((j) => j.status === status).reduce((n, j) => n + j.count, 0);
  const maxLoad = Math.max(1, ...(s.queues ?? []).map((q) => q.waiting + q.active + q.delayed));

  return (
    <>
      <PageCrumbs items={[{ label: t('ops.title') }]} />
      <div className="page-head">
        <div>
          <h1>{t('ops.title')}</h1>
          <p>
            {t('ops.leadShort')} · <LocalTime iso={s.generatedAt} />
          </p>
        </div>
      </div>

      <section className="health" aria-label={t('ops.health')}>
        <HealthCell
          label={t('ops.health.queues')}
          health={s.queues === null ? 'bad' : queuedNow > 0 ? 'warn' : 'ok'}
          icon="operations"
          value={
            s.queues === null
              ? t('ops.health.queuesDown')
              : queuedNow > 0
                ? t('ops.health.queuesBusy', { count: queuedNow })
                : t('ops.health.queuesOk')
          }
          note={t('ops.health.queuesNote', {
            count: (s.queues ?? []).reduce((n, q) => n + q.failed, 0),
          })}
        />
        <HealthCell
          label={t('ops.health.providers')}
          health={openCircuits.length > 0 ? 'bad' : 'ok'}
          icon="generate"
          value={
            openCircuits.length > 0
              ? t('ops.health.providersDown', { count: openCircuits.length })
              : t('ops.health.providersOk')
          }
          note={
            s.circuits.length > 0
              ? s.circuits.map((c) => `${c.providerName}: ${t(`circuit.${c.state}`)}`).join(' · ')
              : t('ops.noProviderFailures')
          }
        />
        <HealthCell
          label={t('ops.health.budgets')}
          health={warnBudgets > 0 ? 'warn' : 'ok'}
          icon="costs"
          value={
            warnBudgets > 0
              ? t('ops.health.budgetsWarn', { count: warnBudgets })
              : t('ops.health.budgetsOk')
          }
          note={t('ops.health.heldNote', { count: s.heldReservations.length })}
        />
        <HealthCell
          label={t('ops.health.failures')}
          health={failed24h > 0 ? 'bad' : 'ok'}
          icon="warning"
          value={t('ops.health.failuresValue', { count: failed24h })}
          note={t('ops.health.failuresNote', { count: done24h })}
        />
      </section>

      {openCircuits.length > 0 && (
        <p className="callout review t-13" role="status">
          {t('ops.circuitNotice', {
            providers: openCircuits.map((c) => c.providerName).join(', '),
          })}
        </p>
      )}

      <section className="card" aria-labelledby="ops-attention">
        <div className="card-head">
          <h3 id="ops-attention">{t('ops.attention')}</h3>
          <span className={attention > 0 ? 'badge danger' : 'badge neutral'}>{attention}</span>
          <span className="spacer" />
          <span className="t-13 muted">{t('ops.attentionOrder')}</span>
        </div>
        {attention === 0 ? (
          <div className="card-body">
            <p className="muted t-13">{t('ops.noFailed')}</p>
          </div>
        ) : (
          <div className="table-box">
            <table className="table" aria-label={t('ops.failedJobs')}>
              <thead>
                <tr>
                  <th scope="col">{t('ops.colProblem')}</th>
                  <th scope="col">{t('ops.colWhere')}</th>
                  <th scope="col">{t('ops.colWhy')}</th>
                  <th scope="col">{t('ops.colWhen')}</th>
                  <th scope="col" className="r">
                    {t('ops.colRecovery')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.failedJobs.map((j) => (
                  <tr key={j.jobId}>
                    <td>
                      <span className="badge danger">
                        <Icon name="warning" size={13} />
                        {t('ops.problem.failed')}
                      </span>
                    </td>
                    <td>
                      <Link href={`/content/${j.contentItemId}`}>
                        <b>{j.contentTitle}</b>
                      </Link>
                      <div className="t-12 muted">
                        {jobKindLabel(t, j.kind)} · {j.projectName} ·{' '}
                        {t('ops.attempts', { count: j.attempt })}
                      </div>
                    </td>
                    <td className="t-13">
                      {j.errorCode ? (
                        <JobErrorLine code={j.errorCode} message={j.errorMessage} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="t-13 muted">
                      <LocalTime iso={j.failedAt} />
                    </td>
                    <td className="r">
                      <ResumeRunButton runId={j.productionRunId} />
                    </td>
                  </tr>
                ))}
                {s.heldReservations.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="badge review">
                        <Icon name="lock" size={13} />
                        {t('ops.problem.held')}
                      </span>
                    </td>
                    <td>
                      <Link href={`/content/${r.contentItemId}`}>
                        <b>{r.contentTitle}</b>
                      </Link>
                      <div className="t-12 muted">
                        {jobKindLabel(t, r.jobKind)} · {r.projectName}
                      </div>
                    </td>
                    <td className="t-13">
                      {t('ops.heldWhy', { amount: formatUsd(r.amountUsd) })}
                      {r.jobErrorCode ? ` · ${r.jobErrorCode}` : ''}
                    </td>
                    <td className="t-13 muted">
                      <LocalTime iso={r.createdAt} />
                    </td>
                    <td className="r">
                      {r.canResolve ? (
                        <ReservationActions reservationId={r.id} label={formatUsd(r.amountUsd)} />
                      ) : (
                        <span className="t-12 muted">{t('ops.ownerResolves')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="row wrap ops-bottom">
        <section className="card ops-queues" aria-labelledby="ops-queues">
          <div className="card-head">
            <h3 id="ops-queues">{t('ops.queues')}</h3>
            <span className="spacer" />
            <span className="t-13 muted">
              {s.queues === null
                ? t('ops.queuesDown')
                : queuesBusy
                  ? t('ops.queuesBusy', { count: queuedNow })
                  : t('ops.queuesIdle')}
            </span>
          </div>
          {s.queues === null ? (
            <div className="card-body">
              <p className="callout danger t-13" role="alert">
                {t('ops.queuesDownBody')}
              </p>
            </div>
          ) : (
            <div className="table-box">
              <table className="table" aria-label={t('ops.queues')}>
                <thead>
                  <tr>
                    <th scope="col">{t('ops.colQueue')}</th>
                    <th scope="col" className="r">
                      {t('ops.colWaiting')}
                    </th>
                    <th scope="col" className="r">
                      {t('ops.colActive')}
                    </th>
                    <th scope="col" className="r">
                      {t('ops.colDelayed')}
                    </th>
                    <th scope="col" className="r">
                      {t('ops.colDead')}
                    </th>
                    <th scope="col">{t('ops.colLoad')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.queues.map((q) => {
                    const label = QUEUE_LABEL[q.queue];
                    const load = q.waiting + q.active + q.delayed;
                    return (
                      <tr key={q.queue}>
                        <td>
                          <b>{label ? t(label) : q.queue}</b>
                          <div className="mono muted">{q.queue}</div>
                        </td>
                        <td className="r num">{q.waiting}</td>
                        <td className="r num">{q.active}</td>
                        <td className="r num">{q.delayed}</td>
                        <td className={q.failed > 0 ? 'r num bad-num' : 'r num'}>{q.failed}</td>
                        <td className="load-cell">
                          <span className="meter thin">
                            <i
                              className="run"
                              style={{ width: `${String(Math.round((load / maxLoad) * 100))}%` }}
                            />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card ops-24h" aria-label={t('ops.last24')}>
          <div className="card-head">
            <h3>{t('ops.last24')}</h3>
          </div>
          <div className="card-body col">
            <div className="row">
              <span className="t-13">{t('ops.succeeded')}</span>
              <span className="spacer" />
              <b className="num">{done24h}</b>
            </div>
            <div className="row">
              <span className="t-13">{t('ops.failed')}</span>
              <span className="spacer" />
              <b className={failed24h > 0 ? 'num bad-num' : 'num'}>{failed24h}</b>
            </div>
            <div className="row">
              <span className="t-13">{t('ops.running24')}</span>
              <span className="spacer" />
              <b className="num">{count24('running') + count24('queued')}</b>
            </div>
            <div className="row">
              <span className="t-13">{t('ops.held')}</span>
              <span className="spacer" />
              <b className="num">{s.heldReservations.length}</b>
            </div>
            <p className="t-12 muted">
              {t('ops.kinds', { kinds: kinds.map((k) => jobKindLabel(t, k)).join(', ') || '—' })}
            </p>
            <div className="divider" />
            <h4 className="t-13">{t('ops.budgets')}</h4>
            {s.budgets.length === 0 ? (
              <p className="muted t-13">{t('ops.noMembership')}</p>
            ) : (
              <ul className="col plain-list ops-budgets" aria-label={t('ops.budgetsLabel')}>
                {s.budgets.map((b) => (
                  <li key={b.projectId} className="row t-13">
                    <Link href={`/projects/${b.projectId}/costs`}>{b.projectName}</Link>
                    <span className="spacer" />
                    <span className="num">
                      {t('ops.budgetLine', {
                        used: formatUsd(b.usedUsd),
                        limit: formatUsd(b.limitUsd),
                      })}
                    </span>
                    {b.warning && <Pill tone="amber">{t('costs.warning80')}</Pill>}
                  </li>
                ))}
              </ul>
            )}
            <Link className="t-13" href="/costs">
              {t('ops.openCosts')}
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}

function HealthCell(props: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly icon: IconName;
  readonly health: Health;
}) {
  return (
    <div className={`card hcell ${props.health}`}>
      <span className="eyebrow">{props.label}</span>
      <span className="big">
        <Icon
          name={props.health === 'ok' ? 'check' : props.health === 'warn' ? props.icon : 'warning'}
          size={20}
        />
        {props.value}
      </span>
      <span className="t-13 muted">{props.note}</span>
    </div>
  );
}
