import {
  meetsQualityTier,
  ProviderStatus,
  type Capability,
  type QualityTier,
} from './capability.js';

/** A registry model as routing sees it. */
export interface ModelCandidate {
  readonly modelId: string;
  readonly modelKey: string;
  readonly providerKey: string;
  readonly capabilities: readonly Capability[];
  /**
   * Parameters usable with this model: the registry entry intersected with what the provider's
   * adapter can send (see {@link effectiveParameters}).
   */
  readonly supportedParameters: readonly string[];
  readonly qualityTier: QualityTier;
  readonly modelStatus: ProviderStatus;
  readonly providerStatus: ProviderStatus;
  /** The provider has credentials configured in this deployment. */
  readonly providerConfigured: boolean;
}

export interface RoutingRequirement {
  readonly capability: Capability;
  readonly parameters: ReadonlySet<string>;
  readonly minimumTier: QualityTier;
  /** Restrict to one model (M2 callers always name the model). */
  readonly modelKey?: string;
}

export const RejectionReason = {
  NOT_REQUESTED: 'not_requested',
  PROVIDER_NOT_ENABLED: 'provider_not_enabled',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  MODEL_NOT_ENABLED: 'model_not_enabled',
  CAPABILITY_UNSUPPORTED: 'capability_unsupported',
  PARAMETER_UNSUPPORTED: 'parameter_unsupported',
  BELOW_QUALITY_TIER: 'below_quality_tier',
} as const;
export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

export interface RejectedCandidate {
  readonly candidate: ModelCandidate;
  readonly reasons: readonly RejectionReason[];
  /** Required parameters the model lacks, when `parameter_unsupported`. */
  readonly missingParameters: readonly string[];
}

export interface RoutingDecision {
  readonly eligible: readonly ModelCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  /** One human-readable line per candidate, stored with the invocation. */
  readonly explanation: readonly string[];
}

/** Parameters usable with a model: its registry list, limited to what the adapter can send. */
export function effectiveParameters(
  modelParameters: readonly string[],
  adapterParameters: ReadonlySet<string>,
): readonly string[] {
  return modelParameters.filter((parameter) => adapterParameters.has(parameter));
}

/**
 * Candidate filtering (AI_PROVIDER_STRATEGY §4, steps 1–3 and 7). Budget, project data policy and
 * circuit breaking (steps 4–6) arrive with M7; scoring waits for benchmark data (§9). Degraded
 * providers and models are not eligible.
 */
export function filterCandidates(
  candidates: readonly ModelCandidate[],
  requirement: RoutingRequirement,
): RoutingDecision {
  const eligible: ModelCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const explanation: string[] = [];

  for (const candidate of candidates) {
    const reasons: RejectionReason[] = [];
    if (requirement.modelKey !== undefined && candidate.modelKey !== requirement.modelKey) {
      reasons.push(RejectionReason.NOT_REQUESTED);
    }
    if (candidate.providerStatus !== ProviderStatus.ENABLED) {
      reasons.push(RejectionReason.PROVIDER_NOT_ENABLED);
    }
    if (!candidate.providerConfigured) reasons.push(RejectionReason.PROVIDER_NOT_CONFIGURED);
    if (candidate.modelStatus !== ProviderStatus.ENABLED) {
      reasons.push(RejectionReason.MODEL_NOT_ENABLED);
    }
    if (!candidate.capabilities.includes(requirement.capability)) {
      reasons.push(RejectionReason.CAPABILITY_UNSUPPORTED);
    }
    const supported = new Set(candidate.supportedParameters);
    const missingParameters = [...requirement.parameters].filter((p) => !supported.has(p)).sort();
    if (missingParameters.length > 0) reasons.push(RejectionReason.PARAMETER_UNSUPPORTED);
    if (!meetsQualityTier(candidate.qualityTier, requirement.minimumTier)) {
      reasons.push(RejectionReason.BELOW_QUALITY_TIER);
    }

    const label = `${candidate.modelKey} (${candidate.providerKey})`;
    if (reasons.length === 0) {
      eligible.push(candidate);
      explanation.push(`${label}: eligible`);
    } else {
      rejected.push({ candidate, reasons, missingParameters });
      const missing =
        missingParameters.length > 0 ? ` [missing: ${missingParameters.join(', ')}]` : '';
      explanation.push(`${label}: rejected (${reasons.join(', ')})${missing}`);
    }
  }
  return { eligible, rejected, explanation };
}
