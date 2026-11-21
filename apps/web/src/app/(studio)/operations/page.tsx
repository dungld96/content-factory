import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { OpsSummaryDto } from '@acf/contracts';

import { JobErrorLine } from '@/components/job-error';
import { LocalTime } from '@/components/local-time';
import { ResumeRunButton } from '@/components/resume-run';
import { Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { JOB_KIND_LABEL } from '@/lib/format';
import { formatUsd } from '@/lib/money';

import { ReservationActions } from './reservation-actions';

export const metadata: Metadata = { title: 'Operations · Content Studio' };
export const dynamic = 'force-dynamic';

/** What each BullMQ queue carries (UX review U6). */
const QUEUE_LABEL: Readonly<Record<string, string>> = {
  generation: 'Scripts and storyboards',
  'generation-images': 'Keyframes',
  'generation-video': 'Clips',
  'generation-audio': 'Voice-overs',
  'generation-render': 'Renders',
  'generation-dlq': 'Dead letters (failed after all retries)',
};

const CIRCUIT_TONE = { closed: 'green', half_open: 'amber', open: 'red' } as const;
const CIRCUIT_LABEL = { closed: 'Closed', half_open: 'Trying again', open: 'Open' } as const;

/**
 * Operations page (M7 design §8, B8): queues, failures with Resume, provider circuits, budgets and
 * held reservations. Project data comes only from the caller's projects.
 */
export default async function OperationsPage() {
  const summary = await apiGet<OpsSummaryDto>('/ops/summary');
  if (summary.kind === 'unauthenticated') redirect('/login');
  if (summary.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        The operations summary could not be loaded.
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

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Production / Operations</div>
          <h1>Operations</h1>
          <p>
            Queues, failures, provider health and budgets. Updated <LocalTime iso={s.generatedAt} />
            .
          </p>
        </div>
      </div>

      {openCircuits.length > 0 && (
        <p className="notice" role="status">
          {openCircuits.map((c) => c.providerName).join(', ')}: unavailable, work waits and retries
          automatically.
        </p>
      )}

      <section className="stats" aria-label="Last 24 hours">
        <div className="card stat">
          <div className="stat-top">Succeeded (24 h)</div>
          <div className="stat-value">{done24h}</div>
          <div className="stat-foot">jobs of your projects</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Failed (24 h)</div>
          <div className="stat-value">{failed24h}</div>
          <div className="stat-foot">after all retries</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Held reservations</div>
          <div className="stat-value">{s.heldReservations.length}</div>
          <div className="stat-foot">outcome unknown: needs an owner</div>
        </div>
      </section>

      <section className="card card-pad">
        <h2>Failed jobs</h2>
        {s.failedJobs.length === 0 ? (
          <p className="muted small-text">No failed jobs in your projects.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Failed jobs">
              <thead>
                <tr>
                  <th scope="col">Content</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Error</th>
                  <th scope="col">Failed</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
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
                    <td>{JOB_KIND_LABEL[j.kind] ?? j.kind}</td>
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
        <h2>Held reservations</h2>
        <p className="muted small-text">
          A provider call whose outcome is unknown (e.g. a clip submission that lost its reply)
          keeps its reserved amount counted until an owner checks the provider and records it.
        </p>
        {s.heldReservations.length === 0 ? (
          <p className="muted small-text">Nothing to resolve.</p>
        ) : (
          <ul className="plain-list" aria-label="Held reservations">
            {s.heldReservations.map((r) => (
              <li key={r.id}>
                <b>{formatUsd(r.amountUsd)}</b> · {JOB_KIND_LABEL[r.jobKind] ?? r.jobKind} of{' '}
                <Link href={`/content/${r.contentItemId}`}>{r.contentTitle}</Link> ({r.projectName})
                {r.jobErrorCode ? ` · ${r.jobErrorCode}` : ''} · <LocalTime iso={r.createdAt} />{' '}
                {r.canResolve ? (
                  <ReservationActions reservationId={r.id} label={formatUsd(r.amountUsd)} />
                ) : (
                  <span className="muted small-text">(an owner resolves it)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <details open={queuesBusy}>
          <summary>
            <h2 style={{ display: 'inline' }}>Queues</h2>{' '}
            <span className="muted small-text">
              {s.queues === null
                ? 'queue server not answering'
                : queuesBusy
                  ? `${String(queuedNow)} waiting or running`
                  : 'all idle'}
            </span>
          </summary>
          {s.queues === null ? (
            <p className="notice error" role="alert">
              The queue server did not answer. Work already queued is kept in the database and
              resumed.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Queues">
                <thead>
                  <tr>
                    <th scope="col">Queue</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Active</th>
                    <th scope="col">Delayed</th>
                    <th scope="col">Failed / dead-lettered</th>
                  </tr>
                </thead>
                <tbody>
                  {s.queues.map((q) => (
                    <tr key={q.queue}>
                      <td>
                        {QUEUE_LABEL[q.queue] ?? q.queue}
                        <br />
                        <code className="muted small-text">{q.queue}</code>
                      </td>
                      <td>{q.waiting}</td>
                      <td>{q.active}</td>
                      <td>{q.delayed}</td>
                      <td>{q.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>
      <section className="card card-pad">
        <h2>Providers</h2>
        {s.circuits.length === 0 ? (
          <p className="muted small-text">No provider has failed recently.</p>
        ) : (
          <ul className="plain-list" aria-label="Provider circuits">
            {s.circuits.map((c) => (
              <li key={c.providerKey}>
                <Pill tone={CIRCUIT_TONE[c.state]}>{CIRCUIT_LABEL[c.state]}</Pill> {c.providerName}
                {c.consecutiveFailures > 0
                  ? ` · ${String(c.consecutiveFailures)} failure(s) in a row`
                  : ''}
                {c.lastErrorCode ? ` · last ${c.lastErrorCode}` : ''}
                {c.retryAt && c.state === 'open' && (
                  <>
                    {' '}
                    · retries after <LocalTime iso={c.retryAt} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card card-pad">
        <h2>Budgets this month</h2>
        {s.budgets.length === 0 ? (
          <p className="muted small-text">You are not a member of any project.</p>
        ) : (
          <ul className="plain-list" aria-label="Project budgets">
            {s.budgets.map((b) => (
              <li key={b.projectId}>
                <Link href={`/projects/${b.projectId}/costs`}>{b.projectName}</Link>:{' '}
                {formatUsd(b.usedUsd)} of {formatUsd(b.limitUsd)}
                {b.heldUsd !== '0' ? ` (${formatUsd(b.heldUsd)} held)` : ''}{' '}
                {b.warning && <Pill tone="amber">80 %+</Pill>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
