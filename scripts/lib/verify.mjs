import { createHash } from "node:crypto";

const USER_AGENT = "straw-boss-desk-check-stack";
const RETRY_DELAYS_MS = [2000, 5000];
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a network failure or a 429/5xx answer twice; any other status is final. */
async function fetchWithRetry(url, { fetchImpl, timeoutMs, delays }) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Downloads `url` and returns the SHA256 of its bytes. The bytes are hashed as they arrive and never written to disk. */
export async function sha256OfUrl(url, { fetchImpl = fetch, delays = RETRY_DELAYS_MS } = {}) {
  let lastError;
  // A download that breaks halfway is retried as a whole, like a failed request.
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      const response = await fetchWithRetry(url, { fetchImpl, timeoutMs: DOWNLOAD_TIMEOUT_MS, delays: [] });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`);
        if (response.status < 500 && response.status !== 429) error.final = true;
        throw error;
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      return { sha256: hash.digest("hex"), bytes };
    } catch (error) {
      lastError = error;
      if (error.final) break;
    }
  }
  throw lastError;
}

/** Checks one asset: the downloaded bytes must hash to the pinned SHA256. Returns { ok, detail }. */
export async function verifyAsset(asset, options) {
  try {
    const { sha256, bytes } = await sha256OfUrl(asset.url, options);
    if (sha256 !== asset.sha256) return { ok: false, detail: `SHA256 mismatch: pinned ${asset.sha256}, downloaded ${sha256} (${bytes} bytes)` };
    return { ok: true, detail: `${bytes} bytes` };
  } catch (error) {
    return { ok: false, detail: `download failed: ${error.message}` };
  }
}

/** Checks one package against the registry's dist.integrity for that exact version. Returns { ok, detail }. */
export async function verifyPackage(pkg, { registry = "https://registry.npmjs.org", fetchImpl = fetch, delays = RETRY_DELAYS_MS } = {}) {
  const url = `${registry.replace(/\/+$/, "")}/${pkg.name.replace("/", "%2F")}/${pkg.version}`;
  try {
    const response = await fetchWithRetry(url, { fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS, delays });
    if (response.status === 404) {
      await response.body?.cancel();
      return { ok: false, detail: `${pkg.name}@${pkg.version} is not on the registry` };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, detail: `registry answered HTTP ${response.status}` };
    }
    const manifest = await response.json();
    const integrity = manifest?.dist?.integrity;
    if (integrity !== pkg.integrity) return { ok: false, detail: `integrity mismatch: pinned ${pkg.integrity}, registry has ${integrity ?? "none"}` };
    if (manifest.version !== pkg.version) return { ok: false, detail: `registry answered version ${manifest.version}` };
    return { ok: true, detail: manifest.deprecated ? `deprecated: ${manifest.deprecated}` : "" };
  } catch (error) {
    return { ok: false, detail: `registry request failed: ${error.message}` };
  }
}

/** Runs `worker` over `items` with at most `limit` in flight, returning the results in order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}
