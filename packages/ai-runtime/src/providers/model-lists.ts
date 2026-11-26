// Vendor model listings are constructed only here (ESLint `no-restricted-imports`, M2 P6).
import { listMixRouteModels, MIXROUTE_PROVIDER_KEY } from '@acf/ai-core/mixroute';
import type { AiProviderEnv } from '@acf/config';

/** The model ids a gateway key may call; free, no prices (P5: MixRoute import). */
export type ModelListing = (signal?: AbortSignal) => Promise<string[]>;

/** Listings for the gateways this deployment has keys for and that have no public catalog. */
export function createModelListings(env: AiProviderEnv): ReadonlyMap<string, ModelListing> {
  const listings = new Map<string, ModelListing>();
  const apiKey = env.MIXROUTE_API_KEY;
  if (apiKey !== undefined) {
    listings.set(MIXROUTE_PROVIDER_KEY, (signal) =>
      listMixRouteModels(
        { apiKey, baseUrl: env.MIXROUTE_BASE_URL, timeoutMs: env.MIXROUTE_TIMEOUT_MS },
        signal,
      ),
    );
  }
  return listings;
}
