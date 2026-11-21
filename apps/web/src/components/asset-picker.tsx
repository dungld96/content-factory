'use client';

import { useEffect, useState } from 'react';

import type { AssetDto, Page } from '@acf/contracts';

import { Modal } from '@/components/modal';
import { ApprovalPill } from '@/components/status-pill';
import { fetchJson } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';

const PAGE = 48;

export const assetName = (a: AssetDto) =>
  a.originalFilename ?? a.label ?? `${a.assetType}-${a.id.slice(0, 8)}`;

/** An asset can be bound to production: active and not rejected (P2b L2). */
export const selectable = (a: AssetDto) => a.archivedAt === null && a.approvalStatus !== 'rejected';

/**
 * Chooses existing Library assets (P2b design L2). It never uploads: files are added only in the
 * Asset library. Returns asset IDs; the caller stores them through its versioned API.
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
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([...props.selected]);

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    const queries = props.types.map((t) => {
      const query = new URLSearchParams({ limit: String(PAGE), assetType: t });
      if (q.trim()) query.set('q', q.trim());
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
  }, [props.open, props.projectId, props.types, q]);

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

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description="Choose from the Asset library. To add a file, upload it in the Asset library first."
    >
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
      {assets === null ? (
        <p className="muted small-text" aria-busy="true">
          Loading…
        </p>
      ) : assets.length === 0 ? (
        <p className="muted small-text">No matching assets in this project.</p>
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
                    <span>{a.mimeType}</span>
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
