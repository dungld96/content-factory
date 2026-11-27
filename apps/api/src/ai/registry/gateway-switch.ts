import type { AiTask } from '@acf/contracts';

/**
 * Planning for "switch every task to one gateway" (P5 decision G6). Pure: the service loads the
 * routes and the target gateway's routable models, this decides per task what to route to.
 */

export interface GatewayModel {
  readonly modelKey: string;
  readonly displayName: string;
}

export interface CurrentRoute {
  readonly providerKey: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly zeroDataRetention: boolean;
}

export type KeptBecause = 'already_on_gateway' | 'no_candidate' | 'zdr_required' | 'not_chosen';

export interface TaskSwitchPlan {
  readonly task: AiTask;
  readonly current: CurrentRoute | null;
  readonly candidates: readonly GatewayModel[];
  readonly target: GatewayModel | null;
  readonly keptBecause: KeptBecause | null;
}

/**
 * A model's identity across gateways: the key without the author prefix, lower case, with `.`
 * and `_` as `-`. `anthropic/claude-haiku-5.5` (OpenRouter) and `claude-haiku-5-5` (MixRoute)
 * are the same family; dated or vendor-prefixed ids (Seedream) do not match and fall back to the
 * single-candidate rule.
 */
export function modelFamily(modelKey: string): string {
  const slug = modelKey.slice(modelKey.lastIndexOf('/') + 1);
  return slug.toLowerCase().replace(/[._]/g, '-');
}

/** The equivalent model: same family, else the only candidate; none when ambiguous. */
export function suggestModel(
  current: CurrentRoute | null,
  candidates: readonly GatewayModel[],
): GatewayModel | null {
  if (current) {
    const family = modelFamily(current.modelKey);
    const same = candidates.find((c) => modelFamily(c.modelKey) === family);
    if (same) return same;
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export class GatewayChoiceError extends Error {
  override readonly name = 'GatewayChoiceError';
}

export function planGatewaySwitch(input: {
  readonly providerKey: string;
  readonly supportsZeroDataRetention: boolean;
  readonly tasks: readonly AiTask[];
  readonly routes: ReadonlyMap<AiTask, CurrentRoute>;
  readonly candidates: ReadonlyMap<AiTask, readonly GatewayModel[]>;
  /** Operator overrides: a model key of the task's candidates, or null to keep the task. */
  readonly choices?: Partial<Record<AiTask, string | null>>;
}): TaskSwitchPlan[] {
  return input.tasks.map((task) => {
    const current = input.routes.get(task) ?? null;
    const candidates = input.candidates.get(task) ?? [];
    const plan = (target: GatewayModel | null, keptBecause: KeptBecause | null) => ({
      task,
      current,
      candidates,
      target,
      keptBecause,
    });
    if (current?.zeroDataRetention && !input.supportsZeroDataRetention) {
      return plan(null, 'zdr_required');
    }
    const choice = input.choices?.[task];
    if (choice === null) {
      return plan(
        null,
        current?.providerKey === input.providerKey ? 'already_on_gateway' : 'not_chosen',
      );
    }
    if (choice !== undefined) {
      const chosen = candidates.find((c) => c.modelKey === choice);
      if (!chosen) {
        throw new GatewayChoiceError(
          `${choice} is not a routable ${input.providerKey} model for ${task}`,
        );
      }
      if (current?.providerKey === input.providerKey && current.modelKey === chosen.modelKey) {
        return plan(null, 'already_on_gateway');
      }
      return plan(chosen, null);
    }
    if (current?.providerKey === input.providerKey) return plan(null, 'already_on_gateway');
    if (candidates.length === 0) return plan(null, 'no_candidate');
    const suggested = suggestModel(current, candidates);
    return suggested ? plan(suggested, null) : plan(null, 'not_chosen');
  });
}
