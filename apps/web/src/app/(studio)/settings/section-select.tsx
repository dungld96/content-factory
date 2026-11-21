'use client';

import { useRouter } from 'next/navigation';

/** Settings sections as a menu on small screens, where the side navigation is hidden. */
export function SectionSelect(props: {
  readonly current: string;
  readonly options: readonly {
    readonly href: string;
    readonly id: string;
    readonly label: string;
  }[];
}) {
  const router = useRouter();
  return (
    <label className="field settings-section-select">
      Section
      <select
        value={props.current}
        onChange={(e) => {
          const target = props.options.find((o) => o.id === e.target.value);
          if (target) router.push(target.href);
        }}
      >
        {props.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
