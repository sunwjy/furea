// The Cloudflare REST API, called directly (ADR 0006, ADR 0015). `fetch` is a constructor argument so
// tests replay recorded fixtures and the published CLI needs no network library (ADR 0007).

export const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareMessage {
  code: number;
  message: string;
}

export class CloudflareApiError extends Error {
  override name = "CloudflareApiError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errors: CloudflareMessage[],
  ) {
    const detail = errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${status}`;
    super(`${method} ${path}: ${detail}`);
  }

  hasCode(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

export interface Account {
  id: string;
  name: string;
}

export interface TokenStatus {
  id: string;
  status: string;
}

export interface CloudflareClientOptions {
  token: string;
  fetch: typeof fetch;
  baseUrl?: string;
}

interface Envelope<T> {
  success?: boolean;
  errors?: CloudflareMessage[];
  result: T;
}

export class CloudflareClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: CloudflareClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#base = options.baseUrl ?? API_BASE;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await this.#fetch(`${this.#base}${path}`, init);
    let envelope: Partial<Envelope<T>> = {};
    try {
      envelope = (await response.json()) as Partial<Envelope<T>>;
    } catch {
      // A non-JSON answer is reported by its status alone.
    }
    if (!response.ok || envelope.success === false) {
      throw new CloudflareApiError(method, path, response.status, envelope.errors ?? []);
    }
    return envelope.result as T;
  }

  /** Every account the token can see; answers for user and account-owned tokens alike. */
  listAccounts(): Promise<Account[]> {
    return this.request<Account[]>("GET", "/accounts?per_page=50");
  }

  verifyUserToken(): Promise<TokenStatus> {
    return this.request<TokenStatus>("GET", "/user/tokens/verify");
  }

  verifyAccountToken(accountId: string): Promise<TokenStatus> {
    return this.request<TokenStatus>("GET", `/accounts/${accountId}/tokens/verify`);
  }
}
