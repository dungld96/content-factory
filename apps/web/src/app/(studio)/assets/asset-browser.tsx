'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { AssetDto, AssetUsageDto, GenerationJobDto, LineageResponse } from '@acf/contracts';

import { LocalTime } from '@/components/local-time';
import { ApprovalPill, Pill } from '@/components/status-pill';
import { fetchJson } from '@/lib/api-client';
import { assetContentUrl } from '@/lib/asset-url';
import { formatBytes, formatSeconds } from '@/lib/format';
import { addUsd, formatUsd } from '@/lib/money';

export type AssetRow = AssetDto & { readonly projectName: string };

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
  readonly usages: AssetUsageDto[];
  readonly job: GenerationJobDto | null;
}

/** Loads what the API records about where an asset came from and where it is used. */
function useProvenance(asset: AssetDto | null): Provenance | 'loading' | null {
  const [state, setState] = useState<{ id: string; value: Provenance } | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    void Promise.all([
      fetchJson<LineageResponse>(`/assets/${asset.id}/lineage?direction=ancestors`),
      fetchJson<{ data: AssetUsageDto[] }>(`/assets/${asset.id}/usages`),
      asset.generationJobId
        ? fetchJson<GenerationJobDto>(`/generation-jobs/${asset.generationJobId}`)
        : Promise.resolve(null),
    ]).then(([lineage, usages, job]) => {
      if (!live) return;
      setState({
        id: asset.id,
        value: {
          ancestors: (lineage?.data ?? [])
            .filter((n) => n.asset.id !== asset.id)
            .map((n) => n.asset),
          usages: usages?.data ?? [],
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

function LineagePanel({ asset }: { readonly asset: AssetRow }) {
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
                <dt>Derived from</dt>
                <dd>
                  {provenance.ancestors.length === 0
                    ? 'Nothing (original asset)'
                    : provenance.ancestors.map(nameOf).join(' ← ')}
                </dd>
                <dt>Used by</dt>
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
export function AssetBrowser({ assets }: { readonly assets: readonly AssetRow[] }) {
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
        <LineagePanel asset={selected} />
      ) : (
        <p className="muted small-text" style={{ marginTop: 14 }}>
          Select an asset to see its lineage. <Pill tone="green">Traceability enabled</Pill>
        </p>
      )}
    </>
  );
}
