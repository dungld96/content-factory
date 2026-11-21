/** Minimal cookie jar + fetch wrapper for driving a listening API like a browser would. */
export class CookieJar {
  private cookies = new Map<string, string>();

  store(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    copy.cookies = new Map(this.cookies);
    return copy;
  }
}

export interface CallResult {
  readonly status: number;
  readonly json: unknown;
  readonly setCookie: string[];
  readonly headers: Headers;
  /** The raw response body (binary endpoints, M4a). */
  readonly bytes: Uint8Array;
}

export interface CallOptions {
  readonly body?: unknown;
  /** A raw (binary) request body, sent as-is; set `content-type` in `headers` (M4a). */
  readonly rawBody?: Uint8Array;
  readonly headers?: Record<string, string>;
  /** Do not record Set-Cookie into the jar (simulates a request whose response is ignored). */
  readonly noStore?: boolean;
}

export const WEB_ORIGIN = 'http://localhost:3000';

export function client(baseUrl: string) {
  return async (
    jar: CookieJar | null,
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<CallResult> => {
    // A header set to '' in `options.headers` is omitted entirely (e.g. no Origin).
    const headers = Object.fromEntries(
      Object.entries({
        origin: WEB_ORIGIN,
        'content-type': 'application/json',
        ...(jar ? { cookie: jar.header() } : {}),
        ...options.headers,
      }).filter(([, value]) => value !== ''),
    );
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      redirect: 'manual',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.rawBody === undefined ? {} : { body: Buffer.from(options.rawBody) }),
    });
    if (!options.noStore) jar?.store(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = text;
    }
    return {
      status: res.status,
      json,
      setCookie: res.headers.getSetCookie(),
      headers: res.headers,
      bytes,
    };
  };
}

/** A latch a handler waits on, so tests can pause a request at an exact point. */
export class Gate {
  private release!: () => void;
  private reachedResolve!: () => void;
  readonly released = new Promise<void>((resolve) => (this.release = resolve));
  /** Resolves when the handler has reached the gate (its session is already loaded). */
  readonly reached = new Promise<void>((resolve) => (this.reachedResolve = resolve));

  arrive(): Promise<void> {
    this.reachedResolve();
    return this.released;
  }

  open(): void {
    this.release();
  }
}
