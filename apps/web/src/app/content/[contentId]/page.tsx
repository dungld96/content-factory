import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type {
  ContentItemDto,
  Page,
  ProjectDto,
  ScriptVersionDto,
  StoryboardVersionDetailDto,
  StoryboardVersionDto,
} from '@acf/contracts';

import { LocalTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';

import {
  AutoRefresh,
  BriefCheck,
  GenerateButton,
  ReviewButtons,
  SceneEditor,
  ScriptEditor,
} from './pipeline-controls';

export const metadata: Metadata = { title: 'Content · AI Content Factory' };
export const dynamic = 'force-dynamic';

const STATUS_BADGE: Readonly<Record<string, string>> = {
  approved: 'badge badge-ok',
  rejected: 'badge badge-err',
  pending_review: 'badge badge-warn',
};
const STATUS_LABEL: Readonly<Record<string, string>> = {
  approved: 'Approved',
  rejected: 'Rejected',
  pending_review: 'Pending review',
};

function VersionBadge({ status }: { readonly status: string }) {
  return <span className={STATUS_BADGE[status] ?? 'badge'}>{STATUS_LABEL[status] ?? status}</span>;
}

export default async function ContentPage({
  params,
}: {
  readonly params: Promise<{ contentId: string }>;
}) {
  const { contentId } = await params;
  const item = await apiGet<ContentItemDto>(`/content/${contentId}`);
  if (item.kind === 'unauthenticated') redirect('/login');
  if (item.kind === 'error') {
    if (item.status === 404) notFound();
    return (
      <section className="card" role="alert">
        <p>The content item could not be loaded.</p>
      </section>
    );
  }
  const content = item.data;
  const [project, scripts, storyboards] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${content.projectId}`),
    apiGet<Page<ScriptVersionDto>>(`/content/${contentId}/scripts?limit=20`),
    apiGet<Page<StoryboardVersionDto>>(`/content/${contentId}/storyboards?limit=20`),
  ]);
  const canEdit =
    project.kind === 'ok' && project.data.role !== 'viewer' && content.archivedAt === null;
  const scriptList = scripts.kind === 'ok' ? scripts.data.data : [];
  const storyboardList = storyboards.kind === 'ok' ? storyboards.data.data : [];
  const latestScript = scriptList[0];
  const approvedScript = scriptList.find((s) => s.isApproved);
  const latestStoryboardId = storyboardList[0]?.id;
  const storyboard = latestStoryboardId
    ? await apiGet<StoryboardVersionDetailDto>(`/storyboards/${latestStoryboardId}`)
    : null;
  const generating = content.status === 'scripting' || content.status === 'storyboarding';

  return (
    <>
      <AutoRefresh active={generating} />
      <header className="page-header">
        <div>
          <p className="muted">
            <Link href={`/projects/${content.projectId}`}>
              {project.kind === 'ok' ? project.data.name : 'Project'}
            </Link>
          </p>
          <h1>{content.title}</h1>
        </div>
        <span className="badge" aria-label="Content status">
          {content.status}
        </span>
      </header>

      <section className="card" aria-labelledby="brief">
        <h2 id="brief">Brief</h2>
        <p>{content.brief.topic}</p>
        <p className="muted">
          {content.targetDurationSeconds} s · {content.aspectRatio} · {content.language}
          {content.brief.audience ? ` · for ${content.brief.audience}` : ''}
        </p>
        <BriefCheck contentId={content.id} />
      </section>

      <section className="card" aria-labelledby="script">
        <h2 id="script">Script</h2>
        {generating && content.status === 'scripting' && <p role="status">Generating a script…</p>}
        {canEdit && (
          <GenerateButton
            path={`/content/${content.id}/scripts/generate`}
            label={latestScript ? 'Generate a new script' : 'Generate script'}
            again={latestScript !== undefined}
          />
        )}
        {!latestScript ? (
          <p className="muted">No script yet.</p>
        ) : (
          <article aria-label={`Script version ${String(latestScript.version)}`}>
            <h3>
              v{latestScript.version}: {latestScript.content.title}{' '}
              <VersionBadge status={latestScript.status} />{' '}
              {latestScript.isApproved && <span className="badge badge-ok">In use</span>}
            </h3>
            <p className="muted">
              {latestScript.source === 'generated' ? 'Generated' : 'Edited'}{' '}
              <LocalTime iso={latestScript.createdAt} />
              {latestScript.reviewNote ? ` · note: ${latestScript.reviewNote}` : ''}
            </p>
            <p>
              <strong>Angle:</strong> {latestScript.content.plan.angle}
            </p>
            <p>
              <strong>Hook:</strong> {latestScript.content.hook}
            </p>
            <p>
              <strong>Voice-over:</strong> {latestScript.content.voiceOver}
            </p>
            <p>
              <strong>Call to action:</strong> {latestScript.content.callToAction}
            </p>
            {latestScript.content.claimsRequiringVerification.length > 0 && (
              <div>
                <strong>Claims to verify:</strong>
                <ul>
                  {latestScript.content.claimsRequiringVerification.map((c) => (
                    <li key={c.claim}>
                      {c.claim} <span className="muted">({c.reason})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canEdit && latestScript.status === 'pending_review' && (
              <ReviewButtons kind="scripts" id={latestScript.id} label="script" />
            )}
            {canEdit && <ScriptEditor script={latestScript} />}
          </article>
        )}
        {scriptList.length > 1 && (
          <details>
            <summary>Version history ({scriptList.length})</summary>
            <ul>
              {scriptList.map((s) => (
                <li key={s.id}>
                  v{s.version} · {s.source} · <VersionBadge status={s.status} />
                  {s.isApproved ? ' · in use' : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card" aria-labelledby="storyboard">
        <h2 id="storyboard">Storyboard</h2>
        {!approvedScript ? (
          <p className="muted">Approve a script first (gate 1).</p>
        ) : (
          <>
            {content.status === 'storyboarding' && <p role="status">Generating a storyboard…</p>}
            {canEdit && (
              <GenerateButton
                path={`/scripts/${approvedScript.id}/storyboards/generate`}
                label={
                  storyboardList.length > 0 ? 'Generate a new storyboard' : 'Generate storyboard'
                }
                again={storyboardList.length > 0}
              />
            )}
          </>
        )}
        {storyboard?.kind === 'ok' && (
          <article aria-label={`Storyboard version ${String(storyboard.data.version)}`}>
            <h3>
              v{storyboard.data.version} · {storyboard.data.totalDurationSeconds} s{' '}
              <VersionBadge status={storyboard.data.status} />{' '}
              {storyboard.data.stale && (
                <span className="badge badge-warn">Stale (older script)</span>
              )}
              {storyboard.data.isApproved && <span className="badge badge-ok">In use</span>}
            </h3>
            <table aria-label="Scenes">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Seconds</th>
                  <th>Shot</th>
                  <th>Voice-over</th>
                  <th>Image prompt</th>
                </tr>
              </thead>
              <tbody>
                {storyboard.data.scenes.map((scene) => (
                  <tr key={scene.id}>
                    <td>{scene.sceneNumber}</td>
                    <td>{scene.durationSeconds}</td>
                    <td>
                      {scene.shotType}, {scene.cameraAngle}, {scene.cameraMovement}
                    </td>
                    <td>{scene.voiceOverSegment}</td>
                    <td>{scene.imagePrompt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && storyboard.data.status === 'pending_review' && !storyboard.data.stale && (
              <ReviewButtons kind="storyboards" id={storyboard.data.id} label="storyboard" />
            )}
            {canEdit &&
              storyboard.data.scenes.map((scene) => <SceneEditor key={scene.id} scene={scene} />)}
          </article>
        )}
      </section>
    </>
  );
}
