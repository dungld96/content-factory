import { getT } from '@/lib/i18n/server';

export default async function Loading() {
  const t = await getT();
  return (
    <p className="muted" aria-busy="true">
      {t('common.loading')}
    </p>
  );
}
