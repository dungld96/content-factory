import type { AiModelDto, AiProviderDto } from '@acf/contracts';

/**
 * Models a request can use (P1 design O7): the model and its provider are enabled and the
 * provider has credentials in this deployment. Routing refuses the others anyway; hiding them
 * avoids offering a choice that cannot work.
 */
export function usableModels(
  models: readonly AiModelDto[],
  providers: readonly AiProviderDto[],
): AiModelDto[] {
  const ready = new Set(
    providers.filter((p) => p.status === 'enabled' && p.configured).map((p) => p.key),
  );
  return models.filter((m) => m.status === 'enabled' && ready.has(m.providerKey));
}
