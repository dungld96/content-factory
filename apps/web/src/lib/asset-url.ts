/** Same-origin URL of an asset's bytes (streamed by the API; storage is never exposed). */
export const assetContentUrl = (assetId: string) => `/api/v1/assets/${assetId}/content`;
