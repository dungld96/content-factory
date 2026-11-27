import Link from 'next/link';

import { LocalTime } from '@/components/local-time';
import { Pill } from '@/components/status-pill';
import { fetchApiHealth } from '@/lib/api-health';
import { getT } from '@/lib/i18n/server';

// Always render at request time: status must never be served from a build-time cache.
export const dynamic = 'force-dynamic';

const BADGE = {
  ok: { tone: 'green', label: 'sys.ok' },
  degraded: { tone: 'amber', label: 'sys.degraded' },
  unreachable: { tone: 'red', label: 'sys.unreachable' },
} as const;

/** Public status page: works without signing in. */
export default async function StatusPage() {
  const [health, t] = await Promise.all([fetchApiHealth(), getT()]);
  const badge = BADGE[health.kind];

  return (
    <div className="standalone">
      <section className="card standalone-card wide">
        <div className="section-head">
          <h1>{t('sys.title')}</h1>
          <Pill tone={badge.tone}>{t(badge.label)}</Pill>
        </div>
        {health.kind === 'unreachable' ? (
          <div role="alert">
            <p className="notice error">{health.reason}.</p>
            <p className="muted small-text">
              {t('sys.startHint', { infra: 'pnpm infra:up', api: 'pnpm dev:api' })}
            </p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('sys.dependency')}</th>
                    <th scope="col">{t('sys.status')}</th>
                    <th scope="col">{t('sys.latency')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(health.data.checks).map(([name, check]) => (
                    <tr key={name}>
                      <td className="table-title">{name}</td>
                      <td>
                        <Pill tone={check.status === 'ok' ? 'green' : 'red'}>
                          {check.status === 'ok'
                            ? t('sys.okShort')
                            : (check.error ?? t('sys.error'))}
                        </Pill>
                      </td>
                      <td>{check.latencyMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small-text">
              {t('sys.checkedAt')} <LocalTime iso={health.data.timestamp} />
            </p>
          </>
        )}
        <Link className="link" href="/">
          {t('sys.back')}
        </Link>
      </section>
    </div>
  );
}
