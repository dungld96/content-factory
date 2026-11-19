'use client';

export interface ModelOption {
  readonly modelKey: string;
  readonly label: string;
}

/**
 * Picks the model for one generation request. Lists only enabled models of the capability (the
 * API refuses others); "Default" sends no `modelKey`, so the operator's task route applies.
 */
export function ModelSelect(props: {
  readonly models: readonly ModelOption[];
  readonly value: string;
  readonly onChange: (modelKey: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  if (props.models.length === 0) return null;
  return (
    <label className="field">
      Model
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      >
        <option value="">Default (task route)</option>
        {props.models.map((m) => (
          <option key={m.modelKey} value={m.modelKey}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
