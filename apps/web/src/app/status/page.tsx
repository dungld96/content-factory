import Link from 'next/link';

import { LocalTime } from '@/components/local-time';
import { Pill } from '@/components/status-pill';
import { fetchApiHealth } from '@/lib/api-health';

// Always render at request time: status must never be served from a build-time cache.
export const dynamic = 'force-dynamic';

const BADGE = {
  ok: { tone: 'green', label: 'Operational' },
  degraded: { tone: 'amber', label: 'Degraded' },
  unreachable: { tone: 'red', label: 'API unreachable' },
} as const;

/** Public status page: works without signing in. */
export default async function StatusPage() {
  const health = await fetchApiHealth();
  const badge = BADGE[health.kind];

  return (
    <div className="standalone">
      <section className="card standalone-card wide">
        <div className="section-head">
          <h1>System status</h1>
          <Pill tone={badge.tone}>{badge.label}</Pill>
        </div>
        {health.kind === 'unreachable' ? (
          <div role="alert">
            <p className="notice error">{health.reason}.</p>
            <p className="muted small-text">
              Start dependencies with <code>pnpm infra:up</code> and the API with{' '}
              <code>pnpm dev:api</code>, then reload this page.
            </p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Dependency</th>
                    <th scope="col">Status</th>
                    <th scope="col">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(health.data.checks).map(([name, check]) => (
                    <tr key={name}>
                      <td className="table-title">{name}</td>
                      <td>
                        <Pill tone={check.status === 'ok' ? 'green' : 'red'}>
                          {check.status === 'ok' ? 'ok' : (check.error ?? 'error')}
                        </Pill>
                      </td>
                      <td>{check.latencyMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small-text">
              Checked at <LocalTime iso={health.data.timestamp} />
            </p>
          </>
        )}
        <Link className="link" href="/">
          ← Back to the workspace
        </Link>
      </section>
    </div>
  );
}
