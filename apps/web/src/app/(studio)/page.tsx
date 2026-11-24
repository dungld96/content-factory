import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Icon, type IconName } from '@/components/icon';
import { RelativeTime } from '@/components/local-time';
import { PageCrumbs } from '@/components/shell/page-crumbs';
import { isFinished, isGenerating, statusInfo, type Stage } from '@/lib/content-status';
import { jobErrorText } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatUsd } from '@/lib/money';
import { loadOpsSummary } from '@/lib/ops-summary';
import { loadMonthSpend } from '@/lib/spend';
import { buildTodo, type TodoItem, type TodoKind } from '@/lib/todo';
import { loadWorkspace, type WorkspaceContent } from '@/lib/workspace';

import { RunningNow } from './running-now';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('todo.pageTitle') };
}

type Tone = 'review' | 'danger' | 'info' | 'neutral';

const KIND: Readonly<Record<TodoKind, { tone: Tone; icon: IconName; badgeIcon: IconName }>> = {
  gate: { tone: 'review', icon: 'shield', badgeIcon: 'eye' },
  input: { tone: 'review', icon: 'edit', badgeIcon: 'edit' },
  failed: { tone: 'danger', icon: 'warning', badgeIcon: 'warning' },
  held: { tone: 'review', icon: 'lock', badgeIcon: 'lock' },
  budget: { tone: 'review', icon: 'costs', badgeIcon: 'lock' },
};

const GATE_BADGE: Readonly<Record<1 | 2 | 3 | 4, MessageKey>> = {
  1: 'todo.badge.g1',
  2: 'todo.badge.g2',
  3: 'todo.badge.g3',
  4: 'todo.badge.g4',
};

/** Stages of the "In production" meter, in pipeline order. */
const ORDER: readonly Stage[] = ['draft', 'script', 'storyboard', 'images', 'render', 'done'];

type Tab = 'needs' | 'following' | 'done';

const isToday = (iso: string) => iso.slice(0, 10) === new Date().toISOString().slice(0, 10);

/**
 * To-do (redesign canvas, R-D2): the operator's queue of decisions, oldest first, each with its
 * primary action. Beside it, what is in production, the jobs running now (live) and the videos
 * ready to download. Tabs: what needs you, what you follow (in production) and what finished
 * today.
 */
export default async function TodoPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [workspace, ops, monthSpend, t, locale, query] = await Promise.all([
    loadWorkspace(),
    loadOpsSummary(),
    loadMonthSpend(),
    getT(),
    getLocale(),
    props.searchParams,
  ]);
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card pad callout danger" role="alert">
        {t('todo.loadError')}
      </section>
    );
  }
  const { content, truncated } = workspace.data;
  const todo = buildTodo(content, ops.kind === 'ok' ? ops.data : null);
  // Oldest first: the longest wait is the most urgent decision.
  const decisions = [...todo.items].sort((a, b) => a.at.localeCompare(b.at));
  const following = content.filter((c) => !isFinished(c.status) && !c.archivedAt);
  const doneToday = content.filter((c) => isFinished(c.status) && isToday(c.updatedAt));
  const tab: Tab =
    query['tab'] === 'following' ? 'following' : query['tab'] === 'done' ? 'done' : 'needs';
  const counts = {
    gates: decisions.filter((i) => i.kind === 'gate').length,
    failed: decisions.filter((i) => i.kind === 'failed').length,
    holds: decisions.filter((i) => i.kind === 'held' || i.kind === 'budget').length,
  };
  const summary = [
    counts.gates > 0 && t('todo.sum.gates', { count: counts.gates }),
    counts.failed > 0 && t('todo.sum.failed', { count: counts.failed }),
    counts.holds > 0 && t('todo.sum.holds', { count: counts.holds }),
  ].filter((x): x is string => typeof x === 'string');

  const reasonText = (item: TodoItem) => {
    const detail =
      item.kind === 'held' || item.kind === 'budget'
        ? formatUsd(item.detail ?? '0')
        : (item.detail ?? '');
    const text = t(item.reason, { detail });
    return item.kind === 'failed' && item.detail
      ? `${text}: ${jobErrorText(item.detail, locale)}`
      : text;
  };
  const badgeText = (item: TodoItem) =>
    item.gate ? t(GATE_BADGE[item.gate]) : t(`todo.kind.${item.kind}`);

  const inProduction = content.filter(
    (c) => !isFinished(c.status) && statusInfo(c.status).stage !== 'attention',
  );

  return (
    <>
      <PageCrumbs items={[{ label: t('nav.todo') }]} />
      <div className="page-head">
        <div>
          <h1>
            {decisions.length > 0
              ? t('todo.headline', { count: decisions.length })
              : t('todo.headlineNone')}
          </h1>
          <p>
            {summary.length > 0
              ? `${summary.join(' · ')} — ${t('todo.oldestFirst')}`
              : t('todo.lead')}
            {monthSpend &&
              ` · ${t('todo.summarySpend', {
                spent: formatUsd(monthSpend.spentUsd),
                limit: formatUsd(monthSpend.limitUsd),
              })}`}
          </p>
        </div>
        <span className="spacer" />
        <nav className="seg" aria-label={t('todo.tabs')}>
          <Link
            href="/"
            className={tab === 'needs' ? 'on' : undefined}
            aria-current={tab === 'needs' ? 'page' : undefined}
          >
            {t('todo.tab.needs')} <span className="n">{decisions.length}</span>
          </Link>
          <Link
            href="/?tab=following"
            className={tab === 'following' ? 'on' : undefined}
            aria-current={tab === 'following' ? 'page' : undefined}
          >
            {t('todo.tab.following')} <span className="n">{following.length}</span>
          </Link>
          <Link
            href="/?tab=done"
            className={tab === 'done' ? 'on' : undefined}
            aria-current={tab === 'done' ? 'page' : undefined}
          >
            {t('todo.tab.done')} <span className="n">{doneToday.length}</span>
          </Link>
        </nav>
      </div>

      {truncated && <p className="callout info t-13">{t('todo.truncated')}</p>}
      {ops.kind !== 'ok' && (
        <p className="callout review t-13" role="status">
          {t('todo.opsMissing')}
        </p>
      )}

      <div className="todo-grid">
        <div className="col todo-main">
          {tab === 'needs' && (
            <section className="card" aria-label={t('todo.queue')}>
              {decisions.length === 0 ? (
                <div className="empty">
                  <span className="em-ic">
                    <Icon name="check" size={22} />
                  </span>
                  <h3>{t('todo.emptyTitle')}</h3>
                  <p className="muted t-13">{t('todo.emptyBody')}</p>
                </div>
              ) : (
                decisions.map((item) => {
                  const kind = KIND[item.kind];
                  return (
                    <div key={item.id} className="irow">
                      <span className={`ikind ${kind.tone}`} aria-hidden="true">
                        <Icon name={kind.icon} size={20} />
                      </span>
                      <div className="ttl">
                        <span className="row wrap">
                          <b>{item.title}</b>
                          <span className={`badge ${kind.tone}`}>
                            <Icon name={kind.badgeIcon} size={13} />
                            {badgeText(item)}
                          </span>
                        </span>
                        <span className="t-13 muted">
                          {item.projectName} · {reasonText(item)}
                        </span>
                      </div>
                      <span className="t-13 muted num wait">
                        <RelativeTime iso={item.at} />
                      </span>
                      <Link
                        className={item.kind === 'gate' ? 'btn primary sm' : 'btn sm'}
                        href={item.href}
                      >
                        {t(item.action)}
                        {item.kind === 'gate' && <Icon name="arrowRight" />}
                      </Link>
                    </div>
                  );
                })
              )}
            </section>
          )}
          {tab === 'following' && (
            <ContentRows
              t={t}
              items={following}
              empty={t('todo.followingEmpty')}
              label={t('todo.tab.following')}
            />
          )}
          {tab === 'done' && (
            <ContentRows
              t={t}
              items={doneToday}
              empty={t('todo.doneEmpty')}
              label={t('todo.tab.done')}
            />
          )}

          <section className="card" aria-labelledby="in-production">
            <div className="card-head">
              <h3 id="in-production">{t('todo.inProduction')}</h3>
              <span className="badge neutral">{inProduction.length}</span>
              <span className="spacer" />
              <Link className="t-13" href="/productions?view=board">
                {t('todo.openBoard')}
              </Link>
            </div>
            <div className="card-body col prod-rows">
              {inProduction.length === 0 ? (
                <p className="muted t-13">{t('todo.inProductionEmpty')}</p>
              ) : (
                inProduction.slice(0, 6).map((c) => <ProgressRow key={c.id} item={c} t={t} />)
              )}
            </div>
          </section>
        </div>

        <div className="col todo-side">
          <RunningNow />
          <section className="card" aria-label={t('todo.ready')}>
            <div className="card-head">
              <h3>{t('todo.ready')}</h3>
            </div>
            <div className="card-body col ready-list">
              {todo.ready.length === 0 ? (
                <p className="muted t-13">{t('todo.readyEmpty')}</p>
              ) : (
                todo.ready.map((c) => (
                  <div key={c.id} className="row ready-row">
                    <span className="thumb t3" aria-hidden="true" />
                    <div className="col ready-text">
                      <Link className="t-13 ready-title" href={`/content/${c.id}#render`}>
                        {c.title}
                      </Link>
                      <span className="t-12 muted">
                        {t(`status.${c.status}`)} · <RelativeTime iso={c.updatedAt} /> ·{' '}
                        {t('todo.seconds', { count: c.targetDurationSeconds })}
                      </span>
                    </div>
                    <Link
                      className="btn sm icon"
                      href={`/content/${c.id}#render`}
                      aria-label={t('todo.downloadOf', { title: c.title })}
                    >
                      <Icon name="download" />
                    </Link>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function ContentRows(p: {
  readonly t: Translate;
  readonly items: readonly WorkspaceContent[];
  readonly empty: string;
  readonly label: string;
}) {
  const { t } = p;
  return (
    <section className="card" aria-label={p.label}>
      {p.items.length === 0 ? (
        <div className="empty">
          <p className="muted t-13">{p.empty}</p>
        </div>
      ) : (
        p.items.map((c) => (
          <div key={c.id} className="irow">
            <span
              className={`ikind ${isGenerating(c.status) ? 'info' : 'neutral'}`}
              aria-hidden="true"
            >
              <Icon name="film" size={20} />
            </span>
            <div className="ttl">
              <b>{c.title}</b>
              <span className="t-13 muted">
                {c.projectName} · {t(statusInfo(c.status).label)}
              </span>
            </div>
            <span className="t-13 muted num wait">
              <RelativeTime iso={c.updatedAt} />
            </span>
            <Link className="btn sm" href={`/content/${c.id}`}>
              {t('todo.action.open')}
            </Link>
          </div>
        ))
      )}
    </section>
  );
}

function ProgressRow({ item, t }: { readonly item: WorkspaceContent; readonly t: Translate }) {
  const info = statusInfo(item.status);
  const index = Math.max(0, ORDER.indexOf(info.stage));
  const done = Math.round((index / ORDER.length) * 100);
  const running = isGenerating(item.status) ? Math.round(100 / ORDER.length) : 0;
  return (
    <div className="row wrap prod-row">
      <Link className="t-13 prod-title" href={`/content/${item.id}`}>
        {item.title}
      </Link>
      <div className="meter" aria-hidden="true">
        <i className="ok" style={{ width: `${String(done)}%` }} />
        <i className="run" style={{ width: `${String(running)}%` }} />
      </div>
      <span
        className={`badge ${isGenerating(item.status) ? 'info' : info.tone === 'amber' ? 'review' : 'neutral'}`}
      >
        <Icon name={isGenerating(item.status) ? 'resume' : 'history'} size={13} />
        {t(info.label)}
      </span>
    </div>
  );
}
