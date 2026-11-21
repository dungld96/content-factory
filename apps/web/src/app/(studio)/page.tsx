import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ContentTable } from '@/components/content-table';
import { Icon, type IconName } from '@/components/icon';
import { NewContentButton } from '@/components/forms';
import { StageList } from '@/components/snapshot';
import { isFinished, isInProduction, needsReview, weeklyCreation } from '@/lib/content-status';
import { loadWorkspace } from '@/lib/workspace';

import { writableProjects } from '@/lib/project-options';

export const metadata: Metadata = { title: 'Overview · Content Studio' };
export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

function Stat(props: {
  readonly label: string;
  readonly icon: IconName;
  readonly value: number;
  readonly foot: string;
}) {
  return (
    <div className="card stat">
      <div className="stat-top">
        {props.label}
        <span className="stat-icon" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
      </div>
      <div className="stat-value">{props.value}</div>
      <div className="stat-foot">{props.foot}</div>
    </div>
  );
}

const weekLabel = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });

export default async function OverviewPage() {
  const workspace = await loadWorkspace();
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card card-pad notice error" role="alert">
        The workspace could not be loaded. Reload the page to try again.
      </section>
    );
  }
  const { projects, content, truncated } = workspace.data;
  const now = new Date();
  const inProduction = content.filter((c) => isInProduction(c.status));
  const waiting = content.filter((c) => needsReview(c.status));
  const finished = content.filter((c) => isFinished(c.status));
  const recentlyCreated = content.filter(
    (c) => now.getTime() - new Date(c.createdAt).getTime() <= 30 * DAY_MS,
  );
  const weeks = weeklyCreation(content, now);
  const peak = Math.max(1, ...weeks.map((w) => w.created));
  const owned = projects.filter((p) => p.role === 'owner').length;
  const writable = writableProjects(projects);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace overview</div>
          <h1>Let’s make something.</h1>
          <p>Here’s what’s happening across your content workspace.</p>
        </div>
        <div className="actions">
          <NewContentButton projects={writable} label="Create content" />
        </div>
      </div>

      {truncated && (
        <p className="notice">
          Showing the first 1,000 items per list; some counts may be partial.
        </p>
      )}

      <section className="stats" aria-label="Workspace statistics">
        <Stat
          label="Content items"
          icon="content"
          value={content.length}
          foot={`${String(recentlyCreated.length)} created in the last 30 days`}
        />
        <Stat
          label="In production"
          icon="history"
          value={inProduction.length}
          foot={`${String(waiting.length)} need your review`}
        />
        <Stat
          label="Approved"
          icon="check"
          value={finished.length}
          foot="All review gates passed"
        />
        <Stat
          label="Projects"
          icon="projects"
          value={projects.length}
          foot={`${String(owned)} owned by you`}
        />
      </section>

      <div className="dashboard-grid">
        <section className="card card-pad" aria-labelledby="activity-heading">
          <div className="section-head">
            <div>
              <h2 id="activity-heading">Production activity</h2>
              <p>Content items created per week, last 8 weeks (UTC)</p>
            </div>
          </div>
          <div className="chart" role="img" aria-label="Content created per week">
            {weeks.map((w) => (
              <div
                key={w.weekStart}
                className="bar-group"
                title={`Week of ${weekLabel(w.weekStart)}: ${String(w.created)} created, ${String(w.finished)} approved`}
              >
                <i className="bar" style={{ height: `${String((w.created / peak) * 100)}%` }} />
                <i
                  className="bar dark"
                  style={{ height: `${String((w.finished / peak) * 100)}%` }}
                />
                <span className="bar-label">{weekLabel(w.weekStart)}</span>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-dot pale" />
              Created
            </span>
            <span>
              <i className="legend-dot" />
              Of which approved
            </span>
          </div>
        </section>
        <section className="card card-pad" aria-labelledby="health-heading">
          <div className="section-head">
            <div>
              <h2 id="health-heading">Pipeline health</h2>
              <p>Current content by stage</p>
            </div>
            <Link className="link" href="/pipeline">
              View pipeline →
            </Link>
          </div>
          <StageList items={content} />
        </section>
      </div>

      <section className="card card-pad" style={{ marginTop: 17 }} aria-labelledby="recent-heading">
        <div className="section-head">
          <div>
            <h2 id="recent-heading">Recently updated</h2>
            <p>Pick up where you left off</p>
          </div>
          <Link className="link" href="/content">
            All content →
          </Link>
        </div>
        {content.length === 0 ? (
          <div className="empty">
            <h3>No content yet</h3>
            {writable.length > 0
              ? 'Create your first content item to start a production.'
              : projects.length === 0
                ? 'Create a project first, or ask a project owner to add you.'
                : 'You can view the projects you belong to, but not create content in them.'}
          </div>
        ) : (
          <ContentTable items={content.slice(0, 6)} label="Recently updated" showProject compact />
        )}
      </section>
    </>
  );
}
