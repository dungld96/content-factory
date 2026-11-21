'use client';

import { useEffect, useRef, useState } from 'react';

import type { AssetDto, CollectionListDto, Page } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { ApprovalPill } from '@/components/status-pill';
import { fetchJson, mutate, uploadImage } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { mediaTypeLabel } from '@/lib/media-labels';

const PAGE = 48;

export const assetName = (a: AssetDto) =>
  a.originalFilename ?? a.label ?? `${a.assetType}-${a.id.slice(0, 8)}`;

/** An asset can be bound to production: active and not rejected (P2b L2). */
export const selectable = (a: AssetDto) => a.archivedAt === null && a.approvalStatus !== 'rejected';

/**
 * Chooses Library assets (P2b design L2, P2c). Filter by collection and pick all of a
 * collection at once; "Add to Library" uploads reference images into the Library (and the open
 * collection) through the normal upload path, so they can be chosen at once. Returns asset IDs;
 * the caller stores them through its versioned API.
 */
export function AssetPicker(props: {
  readonly projectId: string;
  readonly open: boolean;
  readonly title: string;
  /** Asset types offered, e.g. ['reference', 'image']. */
  readonly types: readonly AssetDto['assetType'][];
  readonly multiple?: boolean;
  readonly selected: readonly string[];
  readonly onClose: () => void;
  readonly onDone: (assetIds: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [collections, setCollections] = useState<CollectionListDto['data']>([]);
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([...props.selected]);
  const [reload, setReload] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const canUpload = props.types.includes('reference');

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    void fetchJson<CollectionListDto>(`/projects/${props.projectId}/collections`).then((c) => {
      if (live) setCollections(c?.data ?? []);
    });
    return () => {
      live = false;
    };
  }, [props.open, props.projectId]);

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    const queries = props.types.map((t) => {
      const query = new URLSearchParams({ limit: String(PAGE), assetType: t });
      if (q.trim()) query.set('q', q.trim());
      if (collectionId) query.set('collectionId', collectionId);
      return fetchJson<Page<AssetDto>>(`/projects/${props.projectId}/assets?${query.toString()}`);
    });
    void Promise.all(queries).then((pages) => {
      if (!live) return;
      setAssets(
        pages.flatMap((p) => p?.data ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    });
    return () => {
      live = false;
    };
  }, [props.open, props.projectId, props.types, q, collectionId, reload]);

  function toggle(id: string) {
    setChosen((prev) =>
      props.multiple
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : prev[0] === id
          ? []
          : [id],
    );
  }

  function chooseAll() {
    const ids = (assets ?? []).filter(selectable).map((a) => a.id);
    setChosen((prev) => [...new Set([...prev, ...ids])]);
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    const added: string[] = [];
    for (const f of Array.from(files)) {
      const r = await uploadImage<AssetDto>(props.projectId, f, {
        assetType: 'reference',
        label: f.name.replace(/\.[a-z0-9]+$/i, ''),
      });
      if (!r.ok || !r.data) {
        setError(`${f.name}: ${r.message ?? 'the upload failed'}`);
        continue;
      }
      added.push(r.data.id);
      if (collectionId) {
        const link = await mutate('PUT', `/collections/${collectionId}/assets/${r.data.id}`);
        if (!link.ok) setError(`${f.name} was added to the Library but not to the collection.`);
      }
    }
    setUploading(false);
    if (file.current) file.current.value = '';
    if (added.length > 0) {
      setChosen((prev) => (props.multiple ? [...prev, ...added] : added.slice(-1)));
      setReload((n) => n + 1);
    }
  }

  const collectionName = collections.find((c) => c.id === collectionId)?.name;

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description="Choose from the Asset library, or add new reference images to it."
    >
      <div className="picker-toolbar">
        <label className="field">
          Collection
          <select
            value={collectionId}
            onChange={(e) => {
              setCollectionId(e.target.value);
            }}
          >
            <option value="">All assets</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.itemCount})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Search
          <input
            type="search"
            value={q}
            maxLength={100}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
        </label>
        {props.multiple && collectionId && (
          <button type="button" className="btn small" onClick={chooseAll}>
            <Icon name="check" /> Choose all in {collectionName ?? 'collection'}
          </button>
        )}
        {canUpload && (
          <>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple={props.multiple}
              hidden
              aria-label="Image files to add"
              onChange={(e) => void upload(e.target.files)}
            />
            <button
              type="button"
              className="btn small"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              <Icon name="upload" />{' '}
              {uploading
                ? 'Uploading…'
                : collectionName
                  ? `Add to Library · ${collectionName}`
                  : 'Add to Library'}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {assets === null ? (
        <p className="muted small-text" aria-busy="true">
          Loading…
        </p>
      ) : assets.length === 0 ? (
        <p className="muted small-text">
          {collectionId
            ? 'This collection has no matching assets.'
            : 'No matching assets in this project.'}
        </p>
      ) : (
        <ul className="asset-grid" aria-label="Library assets">
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="asset"
                aria-pressed={chosen.includes(a.id)}
                disabled={!selectable(a)}
                onClick={() => {
                  toggle(a.id);
                }}
              >
                <span className="asset-visual">
                  {a.mimeType.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated API stream
                    <img src={assetContentUrl(a.id)} alt={assetName(a)} loading="lazy" />
                  ) : (
                    <span>{mediaTypeLabel(a.mimeType)}</span>
                  )}
                </span>
                <span className="asset-meta">
                  <b>{assetName(a)}</b>
                  <ApprovalPill status={a.approvalStatus} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            props.onDone(chosen);
          }}
        >
          Use {chosen.length === 0 ? 'none' : `${String(chosen.length)} asset(s)`}
        </button>
      </div>
    </Modal>
  );
}
