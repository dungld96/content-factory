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

import { Icon } from '@/components/icon';
import { LocalTime } from '@/components/local-time';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, fetchJson, mutate } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { formatBytes, formatSeconds } from '@/lib/format';
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
    toast(`Collection “${name}” created.`);
    router.refresh();
  }
  return (
    <form className="image-toolbar" aria-label="New collection" onSubmit={(e) => void create(e)}>
      <label className="field">
        New collection
        <input name="name" maxLength={100} placeholder="e.g. Hero shots" required />
      </label>
      <button type="submit" className="btn">
        Create
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
      setError(
        r.code && IN_USE_CODES.has(r.code)
          ? 'In use in a scene: choose another asset for that scene first.'
          : errorText(r),
      );
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
    void act('PATCH', `/assets/${asset.id}`, { label }, 'Label saved.');
  }

  if (asset.archivedAt !== null) {
    return <p className="muted small-text">Archived: read-only.</p>;
  }
  return (
    <div className="image-toolbar" aria-label="Asset actions">
      {REVIEWABLE.has(asset.assetType) && (
        <>
          <button
            type="button"
            className="btn primary"
            disabled={busy || asset.approvalStatus === 'approved'}
            onClick={() => void act('POST', `/assets/${asset.id}/approve`, {}, 'Asset approved.')}
          >
            <Icon name="check" /> Approve
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || asset.approvalStatus === 'rejected'}
            onClick={() => void act('POST', `/assets/${asset.id}/reject`, {}, 'Asset rejected.')}
          >
            <Icon name="reject" /> Reject
          </button>
        </>
      )}
      {editing ? (
        <form className="image-toolbar" onSubmit={saveLabel}>
          <label className="field">
            Label
            <input name="label" defaultValue={asset.label ?? ''} maxLength={200} />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(false);
            }}
          >
            Cancel
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
          Edit label
        </button>
      )}
      {confirmArchive ? (
        <>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void act('POST', `/assets/${asset.id}/archive`, {}, 'Asset archived.')}
          >
            Confirm archive
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setConfirmArchive(false);
            }}
          >
            Keep
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
          Archive
        </button>
      )}
      {collections.length > 0 && (
        <label className="field">
          Add to collection
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
                  `Added to ${c.name}.`,
                );
              }
            }}
          >
            <option value="">Choose…</option>
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
          Remove from this collection
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
      'Removed from the collection.',
    );
  }
}

const SOURCE_LABEL: Readonly<Record<AssetDto['sourceType'], string>> = {
  upload: 'Uploaded',
  import: 'Imported',
  generated: 'Generated',
  derived: 'Derived',
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

const ROLE_LABEL: Readonly<Record<AssetInputListDto['data'][number]['role'], string>> = {
  character: 'character reference',
  environment: 'environment reference',
  scene_reference: 'scene reference',
  keyframe: 'keyframe',
  clip: 'clip',
  voiceover: 'voice-over',
  music: 'music',
};

const USE_LABEL: Readonly<Record<AssetProductionUsageDto['kind'], string>> = {
  generation_input: 'Input',
  keyframe: 'Keyframe',
  clip: 'Chosen clip',
  voiceover: 'Chosen voice-over',
  scene_reference: 'Scene reference',
  render_output: 'Render output',
};

/** One production use, e.g. "Chosen clip · scene 2". */
function usageText(u: AssetProductionUsageDto): string {
  const scene = u.sceneNumber === null ? '' : ` · scene ${String(u.sceneNumber)}`;
  const role = u.kind === 'generation_input' && u.role ? ` (as ${ROLE_LABEL[u.role]})` : '';
  return `${USE_LABEL[u.kind]}${role}${scene}`;
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
  if (asset.mimeType.startsWith('video/')) {
    return (
      <video
        className="media-player"
        controls
        preload="metadata"
        src={assetContentUrl(asset.id)}
        aria-label={`Play ${nameOf(asset)}`}
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
        aria-label={`Play ${nameOf(asset)}`}
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
  const provenance = useProvenance(asset);
  return (
    <section className="card card-pad" style={{ marginTop: 18 }} aria-label="Asset lineage">
      <div className="section-head">
        <div>
          <h2>Asset lineage</h2>
          <p>Every generated asset links back to its job, model, prompt template and scene.</p>
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
        <span className="box-label">Selected asset · {nameOf(asset)}</span>
        <dl className="lineage">
          <dt>Project</dt>
          <dd>{asset.projectName}</dd>
          <dt>Source</dt>
          <dd>
            {SOURCE_LABEL[asset.sourceType]} {asset.assetType}
            {asset.sourceNote ? ` · ${asset.sourceNote}` : ''}
          </dd>
          <dt>File</dt>
          <dd>
            {asset.mimeType} · {formatBytes(asset.sizeBytes)}
            {asset.width && asset.height ? ` · ${String(asset.width)}×${String(asset.height)}` : ''}
          </dd>
          <dt>Checksum</dt>
          <dd>
            <code>sha256:{asset.checksumSha256.slice(0, 12)}…</code>
          </dd>
          <dt>Created</dt>
          <dd>
            <LocalTime iso={asset.createdAt} />
          </dd>
          {asset.contentItemId && (
            <>
              <dt>Content</dt>
              <dd>
                <Link href={`/content/${asset.contentItemId}`}>Open content workspace →</Link>
                {asset.storyboardSceneId && ' (storyboard scene candidate)'}
              </dd>
            </>
          )}
          {provenance === 'loading' ? (
            <>
              <dt>Provenance</dt>
              <dd aria-busy="true">Loading…</dd>
            </>
          ) : (
            provenance && (
              <>
                {provenance.job && (
                  <>
                    <dt>Generation job</dt>
                    <dd>
                      {provenance.job.kind} · {provenance.job.status} ·{' '}
                      <code>{provenance.job.id.slice(0, 8)}…</code>
                    </dd>
                    <dt>Model</dt>
                    <dd>{provenance.job.modelKey}</dd>
                    <dt>Prompt template</dt>
                    <dd>{provenance.job.promptTemplateId}</dd>
                    <dt>Job cost</dt>
                    <dd>
                      {formatUsd(
                        addUsd(provenance.job.cost.reportedUsd, provenance.job.cost.estimatedUsd),
                      )}
                      {provenance.job.cost.unknownCalls > 0
                        ? ` + ${String(provenance.job.cost.unknownCalls)} call(s) of unknown cost`
                        : ''}
                    </dd>
                  </>
                )}
                <dt>Made from</dt>
                <dd>
                  {provenance.inputs.length === 0
                    ? 'No generation inputs'
                    : provenance.inputs.map((i, n) => (
                        <span key={i.asset.id}>
                          {n > 0 ? ', ' : ''}
                          {nameOf(i.asset)} ({ROLE_LABEL[i.role]})
                        </span>
                      ))}
                </dd>
                <dt>Used in</dt>
                <dd>
                  {provenance.production.length === 0
                    ? 'Not used in production'
                    : provenance.production.map((u, n) => (
                        <span
                          key={`${u.kind}-${u.assetId ?? u.storyboardSceneId ?? u.renderId ?? String(n)}`}
                        >
                          {n > 0 ? ', ' : ''}
                          {u.contentItemId ? (
                            <Link href={`/content/${u.contentItemId}`}>{usageText(u)}</Link>
                          ) : (
                            usageText(u)
                          )}
                        </span>
                      ))}
                </dd>
                <dt>Derived from</dt>
                <dd>
                  {provenance.ancestors.length === 0
                    ? 'Nothing (original asset)'
                    : provenance.ancestors.map(nameOf).join(' ← ')}
                </dd>
                <dt>Brand versions</dt>
                <dd>
                  {provenance.usages.length === 0
                    ? 'No character or environment version'
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  if (assets.length === 0) {
    return (
      <section className="card empty">
        <h2>No assets</h2>
        Upload a reference image or audio, or generate scene media from an approved storyboard.
      </section>
    );
  }
  return (
    <>
      <ul className="asset-grid" aria-label="Assets">
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
                  ) : (
                    <span>
                      {asset.mimeType.startsWith('video/')
                        ? '▶ Clip'
                        : asset.mimeType.startsWith('audio/')
                          ? '♪ Audio'
                          : asset.mimeType}
                      {asset.durationMs ? ` · ${formatSeconds(asset.durationMs)}` : ''}
                    </span>
                  )}
                </span>
                <span className="asset-meta">
                  <b>{name}</b>
                  <span>
                    {asset.assetType === 'reference' ? 'Reference' : SOURCE_LABEL[asset.sourceType]}{' '}
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
          Select an asset to see its lineage. <Pill tone="green">Traceability enabled</Pill>
        </p>
      )}
    </>
  );
}
