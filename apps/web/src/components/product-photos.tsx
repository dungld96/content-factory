'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { PRODUCT_REFERENCES_MAX, type ContentBrief } from '@acf/contracts';

import { AssetPicker } from '@/components/asset-picker';
import { useT } from '@/components/i18n-provider';
import { toast } from '@/components/toast';
import { assetContentUrl } from '@/lib/asset-url';
import { errorText, mutate } from '@/lib/api-client';

const TYPES = ['reference', 'image'] as const;

/**
 * Product photos of a brief: Library images sent as references with every keyframe, so the
 * reviewed product looks the same in every scene. Saving PATCHes the brief at `endpoint`
 * (a content item or a content master); other brief fields are kept.
 */
export function ProductPhotos(props: {
  readonly projectId: string;
  readonly brief: ContentBrief;
  /** e.g. `/content/:id` or `/content-masters/:id`. */
  readonly endpoint: string;
  readonly canEdit: boolean;
  /** Shown after saving, e.g. what the change affects. */
  readonly savedText: string;
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = props.brief.productAssetIds ?? [];

  async function save(ids: string[]) {
    setOpen(false);
    if (ids.length === current.length && ids.every((id) => current.includes(id))) return;
    if (ids.length > PRODUCT_REFERENCES_MAX) {
      setError(t('photos.max', { max: PRODUCT_REFERENCES_MAX }));
      return;
    }
    const rest = Object.fromEntries(
      Object.entries(props.brief).filter(([key]) => key !== 'productAssetIds'),
    ) as ContentBrief;
    const brief: ContentBrief = ids.length > 0 ? { ...rest, productAssetIds: ids } : rest;
    const r = await mutate('PATCH', props.endpoint, { brief });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setError(null);
    toast(props.savedText);
    router.refresh();
  }

  return (
    <div className="product-photos" aria-label={t('photos.label')}>
      <div className="product-photos-head">
        <span>
          <b>{t('photos.label')}</b>
          <small className="muted">
            {current.length > 0 ? t('photos.some') : t('photos.none')}
          </small>
        </span>
        {props.canEdit && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setOpen(true);
            }}
          >
            {current.length > 0 ? t('photos.change', { count: current.length }) : t('photos.add')}
          </button>
        )}
      </div>
      {current.length > 0 && (
        <div className="product-photos-thumbs">
          {current.map((id) => (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
            <img key={id} src={assetContentUrl(id)} alt={t('photos.alt')} loading="lazy" />
          ))}
        </div>
      )}
      {open && (
        <AssetPicker
          projectId={props.projectId}
          open
          multiple
          title={t('photos.pickerTitle', { max: PRODUCT_REFERENCES_MAX })}
          types={TYPES}
          selected={current}
          onClose={() => {
            setOpen(false);
          }}
          onDone={(ids) => void save(ids)}
        />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
