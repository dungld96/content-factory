import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RelativeTime } from '@/components/local-time';
import { ContentStatusPill } from '@/components/status-pill';
import { STAGE_LABEL, statusInfo, type Stage } from '@/lib/content-status';
import { loadWorkspace, type WorkspaceContent } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Production pipeline · Content Studio' };
export const dynamic = 'force-dynamic';

const COLUMNS: readonly { readonly stage: Stage; readonly hint: string }[] = [
  { stage: 'draft', hint: 'Brief ready for a script' },
  { stage: 'script', hint: 'Gate 1: script approval' },
  { stage: 'storyboard', hint: 'Gate 2: storyboard approval' },
  { stage: 'images', hint: 'Gate 3: one keyframe per scene' },
  { stage: 'done', hint: 'All gates approved' },
];

function Card({ item }: { readonly item: WorkspaceContent }) {
  return (
    <li>
      <Link href={`/content/${item.id}`} className="card board-card">
        <b>{item.title}</b>
        <span className="subline">{item.projectName}</span>
        <span className="meta">
          <ContentStatusPill status={item.status} />
          <RelativeTime iso={item.updatedAt} />
        </span>
      </Link>
    </li>
  );
}

/** Content items by production stage: the queue of work across projects. */
export default async function PipelinePage() {
  const workspace = await loadWorkspace();
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        The pipeline could not be loaded. Reload the page to try again.
      </section>
    );
  }
  const { content } = workspace.data;
  const byStage = (stage: Stage) => content.filter((c) => statusInfo(c.status).stage === stage);
  const attention = [...byStage('render'), ...byStage('attention')];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Production</div>
          <h1>Production pipeline</h1>
          <p>Every content item by stage. Open one to review and move it through the gates.</p>
        </div>
      </div>

      {attention.length > 0 && (
        <section className="card card-pad" style={{ marginBottom: 16 }} aria-labelledby="attention">
          <div className="section-head">
            <div>
              <h2 id="attention">Needs attention</h2>
              <p>Failed, canceled, waiting for input, or in render and quality review</p>
            </div>
          </div>
          <ul
            className="board-cards"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {attention.map((item) => (
              <Card key={item.id} item={item} />
            ))}
          </ul>
        </section>
      )}

      <div className="board">
        {COLUMNS.map(({ stage, hint }) => {
          const items = byStage(stage);
          return (
            <section key={stage} className="board-column" aria-label={STAGE_LABEL[stage]}>
              <h2>
                {STAGE_LABEL[stage]} <span className="chip-count">{items.length}</span>
              </h2>
              <p className="muted small-text" style={{ margin: '-6px 0 12px' }}>
                {hint}
              </p>
              {items.length === 0 ? (
                <p className="muted small-text">Nothing here.</p>
              ) : (
                <ul className="board-cards">
                  {items.map((item) => (
                    <Card key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
