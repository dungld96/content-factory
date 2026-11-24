import Link from 'next/link';

import { getT } from '@/lib/i18n/server';

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="standalone">
      <section className="card standalone-card">
        <h1>{t('app.notFoundTitle')}</h1>
        <p className="modal-desc">{t('app.notFoundBody')}</p>
        <Link className="btn primary" href="/">
          {t('app.backToWorkspace')}
        </Link>
      </section>
    </div>
  );
}
