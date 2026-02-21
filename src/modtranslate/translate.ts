import { protectPlaceholders } from "./placeholders";

export type Translator = {
  provider: "google-cloud" | "free";
  translate: (text: string) => Promise<string>;
  translateMany: (
    texts: string[],
    opts?: {
      onProgress?: (done: number, total: number) => void;
    },
  ) => Promise<string[]>;
};

type CreateTranslatorOpts = {
  source: string;
  target: string;
  concurrency?: number;
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

class RetryFailedError extends Error {
  override name = "RetryFailedError";
  override cause: unknown;
  constructor(label: string, cause: unknown) {
    super(`${label} failed: ${formatErr(cause)}`);
    this.cause = cause;
  }
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

function unwrapHttpError(e: unknown): HttpError | null {
  if (e instanceof HttpError) return e;
  if (e && typeof e === "object" && "cause" in e) {
    return unwrapHttpError((e as any).cause);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function createLimiter(concurrency: number) {
  const max = clampInt(concurrency, 1, 32);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    const fn = queue.shift();
    if (fn) fn();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      next();
    }
  };
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      const http = unwrapHttpError(e);
      const status = http?.status;

      const isRetryableHttp =
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;
      const isRetryableMsg =
        msg.includes("fetch failed") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("timeout") ||
        msg.includes("tempor") ||
        msg.includes("network") ||
        msg.includes("aborted") ||
        msg.includes("socket") ||
        msg.includes("dns") ||
        msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("500") ||
        msg.includes("504") ||
        msg.includes("429") ||
        msg.includes("rate") ||
        msg.includes("too many") ||
        msg.includes("quota");

      const retryable = isRetryableHttp || isRetryableMsg;

      // If it's not retryable, don't waste time retrying.
      if (!retryable) break;

      const backoff = Math.min(30_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
  throw new RetryFailedError(label, lastErr);
}

async function translateFree(text: string, source: string, target: string): Promise<string> {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;

  if (!Array.isArray(data) || !Array.isArray(data[0])) return text;
  const chunks = data[0] as unknown[];
  const out: string[] = [];
  for (const c of chunks) {
    if (Array.isArray(c) && typeof c[0] === "string") out.push(c[0]);
  }
  return out.join("");
}

async function translateGoogleCloud(text: string, source: string, target: string, apiKey: string): Promise<string> {
  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: text, source, target, format: "text" }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as any;
  const translated = data?.data?.translations?.[0]?.translatedText;
  if (typeof translated !== "string") return text;
  return translated
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isRateLimitError(e: unknown): boolean {
  const http = unwrapHttpError(e);
  if (http) return http.status === 429;
  const msg = String(e).toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many") || msg.includes("quota");
}

function isLikelyGoogleApiError(e: unknown): boolean {
  // Our "Google API" here includes both the free endpoint and Google Cloud API.
  // Basically anything HTTP/network-ish counts.
  const http = unwrapHttpError(e);
  if (http) return true;
  const msg = String(e).toLowerCase();
  return (
    msg.includes("http ") ||
    msg.includes("fetch failed") ||
    msg.includes("translate") ||
    msg.includes("google_translate_api_key") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

async function translateViaGAS(text: string, source: string, target: string): Promise<string> {
  const url =
    Bun.env.GOOGLE_APPS_SCRIPT_URL ??
    "https://script.google.com/macros/s/AKfycbxPh_IjkSYpkfxHoGXVzK4oNQ2Vy0uRByGeNGA6ti3M7flAMCYkeJKuoBrALNCMImEi_g/exec";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, from: source, to: target }),
      signal: controller.signal,
    });

    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`);

    const data = (await res.json()) as unknown;
    const translated = (data as any)?.translation;
    if (typeof translated !== "string" || !translated.trim()) {
      throw new Error("翻訳結果が取得できませんでした。");
    }
    return translated;
  } finally {
    clearTimeout(timeout);
  }
}

export function createTranslator(opts: CreateTranslatorOpts): Translator {
  const envProvider = (Bun.env.TRANSLATE_PROVIDER ?? "").toLowerCase();
  const apiKey = Bun.env.GOOGLE_TRANSLATE_API_KEY;

  const hasCloud = Boolean(apiKey && apiKey.trim().length > 0);

  const provider: Translator["provider"] =
    envProvider === "google-cloud" ? "google-cloud" : hasCloud ? "google-cloud" : "free";

  // Concurrency: higher = faster, but may trigger rate limits.
  // Default is conservative.
  const envConc = Number(Bun.env.TRANSLATE_CONCURRENCY ?? "");
  const defaultConc = provider === "google-cloud" ? 4 : 3;
  const chosenConc =
    typeof opts.concurrency === "number" && Number.isFinite(opts.concurrency) && opts.concurrency > 0
      ? opts.concurrency
      : Number.isFinite(envConc) && envConc > 0
        ? envConc
        : defaultConc;
  const limiter = createLimiter(chosenConc);

  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  const translateRaw = async (text: string): Promise<string> => {
    if (!text.trim()) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;

    const existing = inflight.get(text);
    if (existing) return existing;

    const p = limiter(async () => {
      // Light throttle to avoid rate limits (per request).
      await sleep(60);

      let translated: string;

      const tryGoogleFree = () => withRetry(() => translateFree(text, opts.source, opts.target), "free");
      const tryGoogleCloud = () => {
        if (!hasCloud) throw new Error("GOOGLE_TRANSLATE_API_KEY is not set");
        return withRetry(() => translateGoogleCloud(text, opts.source, opts.target, apiKey!), "google-cloud");
      };
      const tryGas = () => withRetry(() => translateViaGAS(text, opts.source, opts.target), "gas");

      const primaryGoogle = provider === "google-cloud" ? "google-cloud" : "free";
      const secondaryGoogle = primaryGoogle === "google-cloud" ? "free" : "google-cloud";

      const callGoogle = async (which: "free" | "google-cloud") => {
        return which === "free" ? await tryGoogleFree() : await tryGoogleCloud();
      };

      // Desired behavior:
      // - Google API errors (429/500/etc) => fallback to GAS
      // - GAS errors => fallback back to Google API
      try {
        translated = await callGoogle(primaryGoogle);
      } catch (e1) {
        if (!isLikelyGoogleApiError(e1)) throw e1;
        try {
          translated = await tryGas();
        } catch (e2) {
          // GASもダメなら、もう片方のGoogle系へ（利用可能な場合）
          if (secondaryGoogle === "google-cloud" && !hasCloud) {
            throw e2;
          }
          translated = await callGoogle(secondaryGoogle);
        }
      }

      cache.set(text, translated);
      return translated;
    });

    inflight.set(text, p);
    try {
      return await p;
    } finally {
      inflight.delete(text);
    }
  };

  const translateOne = async (text: string): Promise<string> => {
    if (!text) return text;
    const { text: protectedText, restore } = protectPlaceholders(text);
    const t = await translateRaw(protectedText);
    return restore(t);
  };

  return {
    provider,
    translate: translateOne,
    translateMany: async (texts: string[], opts?: { onProgress?: (done: number, total: number) => void }) => {
      const total = texts.length;
      let done = 0;
      const tick = () => {
        done++;
        opts?.onProgress?.(done, total);
      };

      // Parallelize with concurrency limit (inside translateRaw). Preserve order.
      const ps = texts.map(async (t) => {
        try {
          const r = await translateOne(t);
          return r;
        } finally {
          tick();
        }
      });
      return await Promise.all(ps);
    },
  };
}
