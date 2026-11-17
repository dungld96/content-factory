import { fetchApiHealth } from '@/lib/api-health';

// Always render at request time: status must never be served from a build-time cache.
export const dynamic = 'force-dynamic';

const BADGE = {
  ok: { className: 'badge badge-ok', label: 'Operational' },
  degraded: { className: 'badge badge-warn', label: 'Degraded' },
  unreachable: { className: 'badge badge-err', label: 'API unreachable' },
} as const;

export default async function StatusPage() {
  const health = await fetchApiHealth();
  const badge = BADGE[health.kind];

  return (
    <>
      <h1>
        System status <span className={badge.className}>{badge.label}</span>
      </h1>
      {health.kind === 'unreachable' ? (
        <section className="card" role="alert">
          <p>{health.reason}.</p>
          <p className="muted">
            Start dependencies with <code>pnpm infra:up</code> and the API with{' '}
            <code>pnpm dev:api</code>, then reload this page.
          </p>
        </section>
      ) : (
        <section className="card">
          <table>
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
                  <td>{name}</td>
                  <td>
                    <span className={check.status === 'ok' ? 'badge badge-ok' : 'badge badge-err'}>
                      {check.status === 'ok' ? 'ok' : (check.error ?? 'error')}
                    </span>
                  </td>
                  <td>{check.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Checked at {new Date(health.data.timestamp).toLocaleString()}</p>
        </section>
      )}
    </>
  );
}
