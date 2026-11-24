import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NewContentButton } from '@/components/forms';
import { Icon, type IconName } from '@/components/icon';
import { RelativeTime } from '@/components/local-time';
import { StatusBadge, type BadgeState } from '@/components/status-badge';
import { ContentStatusPill } from '@/components/status-pill';
import { loadOpsSummary } from '@/lib/ops-summary';
import { jobErrorText } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatUsd } from '@/lib/money';
import { writableProjects } from '@/lib/project-options';
import { loadMonthSpend } from '@/lib/spend';
import { buildTodo, type TodoItem, type TodoKind } from '@/lib/todo';
import { loadWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('todo.pageTitle') };
}

const KIND: Readonly<Record<TodoKind, { state: BadgeState; label: MessageKey; icon: IconName }>> = {
  gate: { state: 'review', label: 'todo.kind.gate', icon: 'check' },
  input: { state: 'changes', label: 'todo.kind.input', icon: 'edit' },
  failed: { state: 'failed', label: 'todo.kind.failed', icon: 'failed' },
  held: { state: 'budget', label: 'todo.kind.held', icon: 'warning' },
  budget: { state: 'budget', label: 'todo.kind.budget', icon: 'costs' },
};

/**
 * To-do (redesign R2, R-D2): the home page is the operator's queue of decisions, each with its
 * primary action on the row; running work and finished videos sit beside it.
 */
export default async function TodoPage() {
  const [workspace, ops, monthSpend, t, locale] = await Promise.all([
    loadWorkspace(),
    loadOpsSummary(),
    loadMonthSpend(),
    getT(),
    getLocale(),
  ]);
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card card-pad notice error" role="alert">
        {t('todo.loadError')}
      </section>
    );
  }
  const { projects, content, truncated } = workspace.data;
  const todo = buildTodo(content, ops.kind === 'ok' ? ops.data : null);
  const writable = writableProjects(projects);
  const spend = monthSpend && {
    spent: formatUsd(monthSpend.spentUsd),
    limit: formatUsd(monthSpend.limitUsd),
  };
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

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('todo.eyebrow')}</div>
          <h1>
            {todo.items.length > 0
              ? t('todo.headline', { count: todo.items.length })
              : t('todo.headlineNone')}
          </h1>
          <p>
            {t('todo.summary', { count: todo.running.length })}
            {spend && ` · ${t('todo.summarySpend', spend)}`}
          </p>
        </div>
        <div className="actions">
          <NewContentButton projects={writable} label={t('todo.create')} />
        </div>
      </div>

      {truncated && <p className="notice">{t('todo.truncated')}</p>}
      {ops.kind !== 'ok' && (
        <p className="notice" role="status">
          {t('todo.opsMissing')}
        </p>
      )}

      <div className="todo-layout">
        <section className="card todo-queue" aria-labelledby="todo-heading">
          <div className="section-head card-pad-x">
            <div>
              <h2 id="todo-heading">{t('todo.queue')}</h2>
              <p>{t('todo.count', { count: todo.items.length })}</p>
            </div>
          </div>
          {todo.items.length === 0 ? (
            <div className="empty">
              <span className="empty-icon" aria-hidden="true">
                <Icon name="check" size={22} />
              </span>
              <h3>{t('todo.emptyTitle')}</h3>
              <p>
                {projects.length === 0
                  ? t('todo.noProjects')
                  : writable.length === 0
                    ? t('todo.readOnly')
                    : t('todo.emptyBody')}
              </p>
            </div>
          ) : (
            <ul className="todo-list">
              {todo.items.map((item) => {
                const kind = KIND[item.kind];
                return (
                  <li key={item.id} className={`todo-row ${item.kind}`}>
                    <span className="todo-icon" aria-hidden="true">
                      <Icon name={kind.icon} size={18} />
                    </span>
                    <span className="todo-main">
                      <span className="todo-title">
                        <b>{item.title}</b>
                        <StatusBadge state={kind.state} label={t(kind.label)} />
                      </span>
                      <span className="todo-reason">{reasonText(item)}</span>
                      <span className="subline">
                        {item.projectName} · <RelativeTime iso={item.at} />
                      </span>
                    </span>
                    <Link className="btn primary small todo-action" href={item.href}>
                      {t(item.action)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="stack todo-side">
          <section className="card card-pad" aria-labelledby="running-heading">
            <h3 id="running-heading">{t('todo.running')}</h3>
            {todo.running.length === 0 ? (
              <p className="muted small-text">{t('todo.runningEmpty')}</p>
            ) : (
              <ul className="mini-list">
                {todo.running.map((c) => (
                  <li key={c.id}>
                    <Link href={`/content/${c.id}`}>{c.title}</Link>
                    <ContentStatusPill status={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card card-pad" aria-labelledby="ready-heading">
            <h3 id="ready-heading">{t('todo.ready')}</h3>
            {todo.ready.length === 0 ? (
              <p className="muted small-text">{t('todo.readyEmpty')}</p>
            ) : (
              <ul className="mini-list">
                {todo.ready.map((c) => (
                  <li key={c.id}>
                    <Link href={`/content/${c.id}#render`}>{c.title}</Link>
                    <RelativeTime iso={c.updatedAt} />
                  </li>
                ))}
              </ul>
            )}
            <Link className="link" href="/productions">
              {t('todo.allProductions')}
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
