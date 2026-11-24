import { getT } from '@/lib/i18n/server';

export default async function Loading() {
  const t = await getT();
  return (
    <div className="standalone">
      <p className="muted" aria-busy="true">
        {t('sys.checking')}
      </p>
    </div>
  );
}
