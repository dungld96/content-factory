'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';

import type {
  AssetDto,
  AssetInputListDto,
  AssetProductionUsageDto,
  AssetUsagesDto,
  CollectionDto,
  GenerationJobDto,
  LineageResponse,
} from '@acf/contracts';

import { useLocale, useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { LocalTime } from '@/components/local-time';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, fetchJson, mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { formatBytes, formatSeconds } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { mediaTypeLabel } from '@/lib/media-labels';
import { addUsd, formatUsd } from '@/lib/money';

export type AssetRow = AssetDto & {
  readonly projectName: string;
  /** The viewer may review, relabel and archive (editor or owner of an active project). */
  readonly canEdit: boolean;
};

/** Asset types that are reviewed (ImagesService.review). */
const REVIEWABLE = new Set<AssetDto['assetType']>(['reference', 'image', 'video', 'audio']);

const IN_USE_CODES = new Set(['KEYFRAME_INVALID', 'SCENE_SELECTION_INVALID']);

/** Creates a collection in the selected project (P2b L5). */
export function NewCollectionForm({ projectId }: { readonly projectId: string }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function create(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const value = new FormData(formEl).get('name');
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return;
    const r = await mutate('POST', `/projects/${projectId}/collections`, { name });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setError(null);
    formEl.reset();
    toast(t('library.collectionCreated', { name }));
    router.refresh();
  }
  return (
    <form
      className="image-toolbar"
      aria-label={t('library.newCollection')}
      onSubmit={(e) => void create(e)}
    >
      <label className="field">
        {t('library.newCollection')}
        <input
          name="name"
          maxLength={100}
          placeholder={t('library.collectionPlaceholder')}
          required
        />
      </label>
      <button type="submit" className="btn">
        {t('brand.create')}
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** Review, label and archive from the Library (P2a A1); same endpoints as the scene tabs. */
function AssetActions({
  asset,
  collections,
  activeCollectionId,
}: {
  readonly asset: AssetRow;
  readonly collections: readonly CollectionDto[];
  readonly activeCollectionId: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  async function act(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    done: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await mutate(method, path, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.code && IN_USE_CODES.has(r.code) ? t('library.inUse') : errorText(r));
      return;
    }
    toast(done);
    setEditing(false);
    setConfirmArchive(false);
    router.refresh();
  }

  function saveLabel(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('label');
    const label = typeof value === 'string' ? value : '';
    void act('PATCH', `/assets/${asset.id}`, { label }, t('library.labelSaved'));
  }

  if (asset.archivedAt !== null) {
    return <p className="muted small-text">{t('library.archivedReadOnly')}</p>;
  }
  return (
    <div className="image-toolbar" aria-label={t('library.actions')}>
      {REVIEWABLE.has(asset.assetType) && (
        <>
          <button
            type="button"
            className="btn primary"
            disabled={busy || asset.approvalStatus === 'approved'}
            onClick={() =>
              void act('POST', `/assets/${asset.id}/approve`, {}, t('library.approved'))
            }
          >
            <Icon name="check" /> {t('library.approve')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || asset.approvalStatus === 'rejected'}
            onClick={() =>
              void act('POST', `/assets/${asset.id}/reject`, {}, t('library.rejected'))
            }
          >
            <Icon name="reject" /> {t('library.reject')}
          </button>
        </>
      )}
      {editing ? (
        <form className="image-toolbar" onSubmit={saveLabel}>
          <label className="field">
            {t('upload.label')}
            <input name="label" defaultValue={asset.label ?? ''} maxLength={200} />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('common.save')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(false);
            }}
          >
            {t('common.cancel')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setEditing(true);
          }}
        >
          {t('library.editLabel')}
        </button>
      )}
      {confirmArchive ? (
        <>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() =>
              void act('POST', `/assets/${asset.id}/archive`, {}, t('library.archived'))
            }
          >
            {t('library.confirmArchive')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirmArchive(false);
            }}
          >
            {t('library.keep')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            setConfirmArchive(true);
          }}
        >
          {t('library.archive')}
        </button>
      )}
      {collections.length > 0 && (
        <label className="field">
          {t('library.addToCollection')}
          <select
            value=""
            disabled={busy}
            onChange={(e) => {
              const c = collections.find((x) => x.id === e.target.value);
              if (c) {
                void act(
                  'PUT',
                  `/collections/${c.id}/assets/${asset.id}`,
                  {},
                  t('library.addedTo', { name: c.name }),
                );
              }
            }}
          >
            <option value="">{t('library.choose')}</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {activeCollectionId && (
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => void removeFromCollection(activeCollectionId)}
        >
          {t('library.removeFromCollection')}
        </button>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );

  async function removeFromCollection(collectionId: string) {
    await act(
      'DELETE',
      `/collections/${collectionId}/assets/${asset.id}`,
      undefined,
      t('library.removed'),
    );
  }
}

const SOURCE_LABEL: Readonly<Record<AssetDto['sourceType'], MessageKey>> = {
  upload: 'source.upload',
  import: 'source.import',
  generated: 'source.generated',
  derived: 'source.derived',
};

const nameOf = (a: AssetDto) =>
  a.originalFilename ?? a.label ?? `${a.assetType}-${a.id.slice(0, 8)}`;
const isImage = (a: AssetDto) => a.mimeType.startsWith('image/');

interface Provenance {
  readonly ancestors: AssetDto[];
  readonly usages: AssetUsagesDto['data'];
  readonly inputs: AssetInputListDto['data'];
  readonly production: AssetProductionUsageDto[];
  readonly job: GenerationJobDto | null;
}

const ROLE_LABEL = (role: AssetInputListDto['data'][number]['role']): MessageKey =>
  `inputRole.${role}`;

const USE_LABEL = (kind: AssetProductionUsageDto['kind']): MessageKey => `use.${kind}`;

/** One production use, e.g. "Chosen clip · scene 2". */
function usageText(t: Translate, u: AssetProductionUsageDto): string {
  const scene = u.sceneNumber === null ? '' : ` ${t('use.scene', { number: u.sceneNumber })}`;
  const role =
    u.kind === 'generation_input' && u.role
      ? ` ${t('use.asRole', { role: t(ROLE_LABEL(u.role)) })}`
      : '';
  return `${t(USE_LABEL(u.kind))}${role}${scene}`;
}

/** Loads what the API records about where an asset came from and where it is used. */
function useProvenance(asset: AssetDto | null): Provenance | 'loading' | null {
  const [state, setState] = useState<{ id: string; value: Provenance } | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    void Promise.all([
      fetchJson<LineageResponse>(`/assets/${asset.id}/lineage?direction=ancestors`),
      fetchJson<AssetUsagesDto>(`/assets/${asset.id}/usages`),
      fetchJson<AssetInputListDto>(`/assets/${asset.id}/inputs`),
      asset.generationJobId
        ? fetchJson<GenerationJobDto>(`/generation-jobs/${asset.generationJobId}`)
        : Promise.resolve(null),
    ]).then(([lineage, usages, inputs, job]) => {
      if (!live) return;
      setState({
        id: asset.id,
        value: {
          ancestors: (lineage?.data ?? [])
            .filter((n) => n.asset.id !== asset.id)
            .map((n) => n.asset),
          usages: usages?.data ?? [],
          production: usages?.production ?? [],
          inputs: inputs?.data ?? [],
          job,
        },
      });
    });
    return () => {
      live = false;
    };
  }, [asset]);
  if (!asset) return null;
  return state?.id === asset.id ? state.value : 'loading';
}

/** Players for clips and audio (Range-streamed through the API, M5a). */
function MediaPreview({ asset }: { readonly asset: AssetDto }) {
  const t = useT();
  if (asset.mimeType.startsWith('video/')) {
    return (
      <video
        className="media-player"
        controls
        preload="metadata"
        src={assetContentUrl(asset.id)}
        aria-label={t('library.play', { name: nameOf(asset) })}
      />
    );
  }
  if (asset.mimeType.startsWith('audio/')) {
    return (
      <audio
        className="media-player"
        controls
        preload="metadata"
        src={assetContentUrl(asset.id)}
        aria-label={t('library.play', { name: nameOf(asset) })}
      />
    );
  }
  return null;
}

function LineagePanel({
  asset,
  collections,
  activeCollectionId,
}: {
  readonly asset: AssetRow;
  readonly collections: readonly CollectionDto[];
  readonly activeCollectionId: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const provenance = useProvenance(asset);
  return (
    <section className="card card-pad" style={{ marginTop: 18 }} aria-label={t('library.lineage')}>
      <div className="section-head">
        <div>
          <h2>{t('library.lineage')}</h2>
          <p>{t('library.lineageHint')}</p>
        </div>
        <ApprovalPill status={asset.approvalStatus} />
      </div>
      <MediaPreview asset={asset} />
      {asset.canEdit && (
        <AssetActions
          key={asset.id}
          asset={asset}
          collections={collections.filter((c) => c.projectId === asset.projectId)}
          activeCollectionId={activeCollectionId}
        />
      )}
      <div className="brief-box">
        <span className="box-label">{t('library.selected', { name: nameOf(asset) })}</span>
        <dl className="lineage">
          <dt>{t('library.dt.project')}</dt>
          <dd>{asset.projectName}</dd>
          <dt>{t('library.dt.source')}</dt>
          <dd>
            {t(SOURCE_LABEL[asset.sourceType])} {asset.assetType}
            {asset.sourceNote ? ` · ${asset.sourceNote}` : ''}
          </dd>
          <dt>{t('library.dt.file')}</dt>
          <dd>
            {mediaTypeLabel(asset.mimeType, locale)} · {formatBytes(asset.sizeBytes)}
            {asset.width && asset.height ? ` · ${String(asset.width)}×${String(asset.height)}` : ''}
          </dd>
          <dt>{t('library.dt.checksum')}</dt>
          <dd>
            <code>sha256:{asset.checksumSha256.slice(0, 12)}…</code>
          </dd>
          <dt>{t('library.dt.created')}</dt>
          <dd>
            <LocalTime iso={asset.createdAt} />
          </dd>
          {asset.contentItemId && (
            <>
              <dt>{t('library.dt.content')}</dt>
              <dd>
                <Link href={`/content/${asset.contentItemId}`}>{t('library.openWorkspace')}</Link>
                {asset.storyboardSceneId && ` ${t('library.sceneCandidate')}`}
              </dd>
            </>
          )}
          {provenance === 'loading' ? (
            <>
              <dt>{t('library.dt.provenance')}</dt>
              <dd aria-busy="true">{t('common.loading')}</dd>
            </>
          ) : (
            provenance && (
              <>
                {provenance.job && (
                  <>
                    <dt>{t('library.dt.job')}</dt>
                    <dd>
                      {provenance.job.kind} · {provenance.job.status} ·{' '}
                      <code>{provenance.job.id.slice(0, 8)}…</code>
                    </dd>
                    <dt>{t('library.dt.model')}</dt>
                    <dd>{provenance.job.modelKey}</dd>
                    <dt>{t('library.dt.template')}</dt>
                    <dd>{provenance.job.promptTemplateId}</dd>
                    <dt>{t('library.dt.cost')}</dt>
                    <dd>
                      {formatUsd(
                        addUsd(provenance.job.cost.reportedUsd, provenance.job.cost.estimatedUsd),
                      )}
                      {provenance.job.cost.unknownCalls > 0
                        ? ` ${t('library.unknownCalls', { count: provenance.job.cost.unknownCalls })}`
                        : ''}
                    </dd>
                  </>
                )}
                <dt>{t('library.dt.madeFrom')}</dt>
                <dd>
                  {provenance.inputs.length === 0
                    ? t('library.noInputs')
                    : provenance.inputs.map((i, n) => (
                        <span key={i.asset.id}>
                          {n > 0 ? ', ' : ''}
                          {nameOf(i.asset)} ({t(ROLE_LABEL(i.role))})
                        </span>
                      ))}
                </dd>
                <dt>{t('library.dt.usedIn')}</dt>
                <dd>
                  {provenance.production.length === 0
                    ? t('library.notUsed')
                    : provenance.production.map((u, n) => (
                        <span
                          key={`${u.kind}-${u.assetId ?? u.storyboardSceneId ?? u.renderId ?? String(n)}`}
                        >
                          {n > 0 ? ', ' : ''}
                          {u.contentItemId ? (
                            <Link href={`/content/${u.contentItemId}`}>{usageText(t, u)}</Link>
                          ) : (
                            usageText(t, u)
                          )}
                        </span>
                      ))}
                </dd>
                <dt>{t('library.dt.derived')}</dt>
                <dd>
                  {provenance.ancestors.length === 0
                    ? t('library.original')
                    : provenance.ancestors.map(nameOf).join(' ← ')}
                </dd>
                <dt>{t('library.dt.brand')}</dt>
                <dd>
                  {provenance.usages.length === 0
                    ? t('library.noBrand')
                    : provenance.usages
                        .map((u) => `${u.kind} v${String(u.version)} (${u.reference}, ${u.status})`)
                        .join(', ')}
                </dd>
              </>
            )
          )}
        </dl>
      </div>
    </section>
  );
}

/** Asset grid; selecting an asset shows its lineage. */
export function AssetBrowser({
  assets,
  collections = [],
  activeCollectionId = null,
}: {
  readonly assets: readonly AssetRow[];
  readonly collections?: readonly CollectionDto[];
  readonly activeCollectionId?: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  if (assets.length === 0) {
    return (
      <section className="card empty">
        <h2>{t('library.noAssets')}</h2>
        {t('library.noAssetsHint')}
      </section>
    );
  }
  return (
    <>
      <ul className="asset-grid" aria-label={t('library.gridLabel')}>
        {assets.map((asset) => {
          const name = nameOf(asset);
          return (
            <li key={asset.id}>
              <button
                type="button"
                className="asset"
                aria-pressed={asset.id === selectedId}
                onClick={() => {
                  setSelectedId(asset.id === selectedId ? null : asset.id);
                }}
              >
                <span className="asset-visual">
                  {isImage(asset) ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
                    <img src={assetContentUrl(asset.id)} alt={name} loading="lazy" />
                  ) : asset.mimeType.startsWith('video/') ? (
                    // A frame of the clip as its poster (UX review U6); no sound, no controls.
                    <>
                      <video
                        className="asset-poster"
                        src={`${assetContentUrl(asset.id)}#t=0.5`}
                        preload="metadata"
                        muted
                        playsInline
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                      <span className="asset-badge">
                        <Icon name="play" size={12} />
                        {asset.durationMs ? ` ${formatSeconds(asset.durationMs)}` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="asset-kind">
                      <Icon name={asset.mimeType.startsWith('audio/') ? 'music' : 'content'} />
                      {mediaTypeLabel(asset.mimeType, locale)}
                      {asset.durationMs ? ` · ${formatSeconds(asset.durationMs)}` : ''}
                    </span>
                  )}
                </span>
                <span className="asset-meta">
                  <b>{name}</b>
                  <span>
                    {asset.assetType === 'reference'
                      ? t('library.reference')
                      : t(SOURCE_LABEL[asset.sourceType])}{' '}
                    · {formatBytes(asset.sizeBytes)} · {asset.projectName}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected ? (
        <LineagePanel
          asset={selected}
          collections={collections}
          activeCollectionId={activeCollectionId}
        />
      ) : (
        <p className="muted small-text" style={{ marginTop: 14 }}>
          {t('library.selectHint')} <Pill tone="green">{t('library.traceability')}</Pill>
        </p>
      )}
    </>
  );
}
