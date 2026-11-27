'use client';

import { useState } from 'react';

import { Icon } from '@/components/icon';

/**
 * The single next step under the stage rail (redesign canvas: dark action bar). "Skip for now"
 * hides it until the page is loaded again; the step itself stays in To-do.
 */
export function NextStepBar(props: {
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly href: string;
  readonly skip: string;
  readonly ariaLabel: string;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <section className="actionbar" aria-label={props.ariaLabel}>
      <Icon name="warning" size={24} className="actionbar-icon" />
      <div className="col actionbar-text">
        <span className="lbl">{props.label}</span>
        <b>{props.title}</b>
        {props.detail && <span className="actionbar-detail">{props.detail}</span>}
      </div>
      <button
        className="btn ghost"
        type="button"
        onClick={() => {
          setHidden(true);
        }}
      >
        {props.skip}
      </button>
      <a className="btn primary" href={props.href}>
        <Icon name="check" />
        {props.action}
      </a>
    </section>
  );
}
