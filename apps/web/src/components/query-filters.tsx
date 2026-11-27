'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type SyntheticEvent } from 'react';

export interface FilterSelect {
  readonly name: string;
  readonly label: string;
  /** Label of the empty value ("All statuses"). */
  readonly allLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * Filter toolbar backed by the URL query (shareable, survives reload): the server page reads
 * the same parameters. Selects apply on change; the search box applies on Enter.
 */
export function QueryFilters(props: {
  readonly search?: { readonly name: string; readonly placeholder: string };
  readonly selects: readonly FilterSelect[];
  readonly count?: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(name: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const query = next.toString();
    startTransition(() => {
      router.replace(query ? `${path}?${query}` : path, { scroll: false });
    });
  }

  function submitSearch(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (!props.search) return;
    const value = new FormData(event.currentTarget).get(props.search.name);
    apply(props.search.name, typeof value === 'string' ? value.trim() : '');
  }

  return (
    <div className="content-toolbar" aria-busy={pending}>
      {props.search && (
        <form role="search" onSubmit={submitSearch}>
          <input
            key={params.get(props.search.name) ?? ''}
            className="filter"
            type="search"
            name={props.search.name}
            placeholder={props.search.placeholder}
            aria-label={props.search.placeholder}
            defaultValue={params.get(props.search.name) ?? ''}
          />
        </form>
      )}
      {props.selects.map((select) => (
        <select
          key={select.name}
          className="filter"
          aria-label={select.label}
          value={params.get(select.name) ?? ''}
          onChange={(e) => {
            apply(select.name, e.target.value);
          }}
        >
          <option value="">{select.allLabel}</option>
          {select.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}
      {props.count && <span className="toolbar-count">{props.count}</span>}
    </div>
  );
}
