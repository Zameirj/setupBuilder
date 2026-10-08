/**
 * Endpoint that reports the latest Setup Builder release. It may return:
 *   - plain text:  1.0.2
 *   - a JSON string: "1.0.2"
 *   - a JSON object: { "version": "1.0.2", "downloadUrl": "https://...", "notes": "..." }
 * Leave empty to disable the update check.
 */
export const UPDATE_CHECK_URL = ''; // TODO: set to the version endpoint

/** Send the x-api-key from Settings with the update check. */
export const UPDATE_SEND_API_KEY = false;

/** Opened by the Download button when the endpoint gives no downloadUrl. */
export const UPDATE_DOWNLOAD_URL = 'https://example.com/setup-builder/download'; // TODO: replace with the real link

/**
 * Compares dotted versions numerically part by part (1.0.10 > 1.0.9).
 * Non-numeric parts are compared as text. Returns >0 if a is newer.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, '').split(/[.\-+]/);
  const pb = b.trim().replace(/^v/i, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const diff = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (diff !== 0) return diff;
  }
  return 0;
}
