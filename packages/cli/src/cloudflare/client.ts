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

/** "This Worker does not exist on your account", and "no workers.dev subdomain" on the account endpoint. */
export const NOT_FOUND_CODE = 10007;

export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 404 || error.hasCode(NOT_FOUND_CODE));
}

export interface Account {
  id: string;
  name: string;
}

export interface TokenStatus {
  id: string;
  status: string;
}

export interface D1Database {
  uuid: string;
  name: string;
}

export interface KvNamespace {
  id: string;
  title: string;
}

export interface Binding {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface ScriptSettings {
  bindings: Binding[];
  observability?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface D1Result<Row = Record<string, unknown>> {
  success: boolean;
  results: Row[];
  meta?: { changes?: number; [key: string]: unknown };
}

export interface AssetUploadSession {
  jwt: string;
  buckets: string[][];
}

export interface ScriptSubdomain {
  enabled: boolean;
  previews_enabled?: boolean;
}

export interface Tail {
  id: string;
  /** The `trace-v1` WebSocket; the URL itself is the capability. */
  url: string;
  /** Delivery silently stops here, so the CLI recreates the tail itself. */
  expires_at: string;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

/** A Workers Custom Domain: a whole hostname routed to a Worker, DNS record and certificate managed by Cloudflare. */
export interface WorkerDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

export interface CloudflareClientOptions {
  token: string;
  fetch: typeof fetch;
  baseUrl?: string;
}

export interface Envelope<T> {
  success?: boolean;
  errors?: CloudflareMessage[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
}

export interface SendOptions {
  json?: unknown;
  form?: FormData;
  /** A bearer other than the deploy token (the asset upload token). */
  bearer?: string;
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
    return (await this.send<T>(method, path, body === undefined ? {} : { json: body })).result as T;
  }

  /** One API call with a JSON or multipart body; returns the whole envelope, for callers that need `result_info`. */
  async send<T>(method: string, path: string, options: SendOptions = {}): Promise<Partial<Envelope<T>>> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.bearer ?? this.#token}` };
    const init: RequestInit = { method, headers };
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      init.body = options.form;
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
    return envelope;
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

  // D1 and KV (ADR 0006 step 2). Neither name is unique server-side, so lookups compare exactly.

  async findD1Database(accountId: string, name: string): Promise<D1Database | undefined> {
    const path = `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`;
    return (await this.request<D1Database[]>("GET", path)).find((db) => db.name === name);
  }

  createD1Database(accountId: string, name: string): Promise<D1Database> {
    return this.request<D1Database>("POST", `/accounts/${accountId}/d1/database`, { name });
  }

  async findKvNamespace(accountId: string, title: string): Promise<KvNamespace | undefined> {
    for (let page = 1; ; page++) {
      const envelope = await this.send<KvNamespace[]>("GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=1000&page=${page}`);
      const found = (envelope.result ?? []).find((ns) => ns.title === title);
      if (found) return found;
      if (page >= (envelope.result_info?.total_pages ?? 1)) return undefined;
    }
  }

  createKvNamespace(accountId: string, title: string): Promise<KvNamespace> {
    return this.request<KvNamespace>("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title });
  }

  /** One request, which D1 runs as one transaction even with several statements. */
  d1Query<Row = Record<string, unknown>>(accountId: string, databaseId: string, sql: string, params?: unknown[]): Promise<D1Result<Row>[]> {
    const path = `/accounts/${accountId}/d1/database/${databaseId}/query`;
    return this.request<D1Result<Row>[]>("POST", path, params ? { sql, params } : { sql });
  }

  // The Worker script (ADR 0006 steps 2 and 5-8).

  /** The deployed script's bindings, or undefined when there is no script of that name. */
  async getScriptBindings(accountId: string, script: string): Promise<Binding[] | undefined> {
    return (await this.getScriptSettings(accountId, script))?.bindings;
  }

  /** The deployed script's settings (bindings, observability), or undefined when there is no script of that name. */
  async getScriptSettings(accountId: string, script: string): Promise<ScriptSettings | undefined> {
    try {
      const settings = await this.request<Partial<ScriptSettings>>("GET", `/accounts/${accountId}/workers/scripts/${script}/settings`);
      return { ...settings, bindings: settings.bindings ?? [] };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  createAssetUploadSession(
    accountId: string,
    script: string,
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<AssetUploadSession> {
    return this.request<AssetUploadSession>("POST", `/accounts/${accountId}/workers/scripts/${script}/assets-upload-session`, { manifest });
  }

  /** Authorised by the session's upload token, not the deploy token; the last bucket answers with the completion token. */
  async uploadAssets(accountId: string, jwt: string, form: FormData): Promise<{ jwt?: string } | undefined> {
    const envelope = await this.send<{ jwt?: string } | null>("POST", `/accounts/${accountId}/workers/assets/upload?base64=true`, {
      form,
      bearer: jwt,
    });
    return envelope.result ?? undefined;
  }

  async putScript(accountId: string, script: string, form: FormData): Promise<void> {
    await this.send("PUT", `/accounts/${accountId}/workers/scripts/${script}`, { form });
  }

  async getSchedules(accountId: string, script: string): Promise<string[]> {
    const result = await this.request<{ schedules?: Array<{ cron: string }> }>("GET", `/accounts/${accountId}/workers/scripts/${script}/schedules`);
    return (result.schedules ?? []).map((s) => s.cron);
  }

  /** Replaces every schedule of the script. */
  async putSchedules(accountId: string, script: string, crons: string[]): Promise<void> {
    await this.request("PUT", `/accounts/${accountId}/workers/scripts/${script}/schedules`, crons.map((cron) => ({ cron })));
  }

  /** The account's workers.dev subdomain, or undefined when none is registered. */
  async getAccountSubdomain(accountId: string): Promise<string | undefined> {
    try {
      return (await this.request<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`)).subdomain;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async putAccountSubdomain(accountId: string, subdomain: string): Promise<string> {
    return (await this.request<{ subdomain: string }>("PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain })).subdomain;
  }

  getScriptSubdomain(accountId: string, script: string): Promise<ScriptSubdomain> {
    return this.request<ScriptSubdomain>("GET", `/accounts/${accountId}/workers/scripts/${script}/subdomain`);
  }

  setScriptSubdomain(accountId: string, script: string, value: ScriptSubdomain): Promise<ScriptSubdomain> {
    return this.request<ScriptSubdomain>("POST", `/accounts/${accountId}/workers/scripts/${script}/subdomain`, value);
  }

  // Live tail (ADR 0011): the deploy token's Workers Scripts Edit is enough.

  createTail(accountId: string, script: string): Promise<Tail> {
    return this.request<Tail>("POST", `/accounts/${accountId}/workers/scripts/${script}/tails`, { filters: [] });
  }

  async deleteTail(accountId: string, script: string, id: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}/workers/scripts/${script}/tails/${id}`);
  }

  async putSecret(accountId: string, script: string, name: string, text: string): Promise<void> {
    await this.request("PUT", `/accounts/${accountId}/workers/scripts/${script}/secrets`, { name, text, type: "secret_text" });
  }

  // Workers Custom Domains (ADR 0006 step 8, `domain set|unset`).

  /** The zone of exactly this name in the account, if any. */
  async findZone(accountId: string, name: string): Promise<Zone | undefined> {
    const zones = await this.request<Zone[]>("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    return zones.find((zone) => zone.name === name);
  }

  listWorkerDomains(accountId: string, filter: { service: string } | { hostname: string }): Promise<WorkerDomain[]> {
    const query = "service" in filter ? `service=${encodeURIComponent(filter.service)}` : `hostname=${encodeURIComponent(filter.hostname)}`;
    return this.request<WorkerDomain[]>("GET", `/accounts/${accountId}/workers/domains?${query}`);
  }

  attachWorkerDomain(accountId: string, domain: { hostname: string; service: string; zone_id: string }): Promise<WorkerDomain> {
    return this.request<WorkerDomain>("PUT", `/accounts/${accountId}/workers/domains`, domain);
  }

  async detachWorkerDomain(accountId: string, domainId: string): Promise<void> {
    await this.send("DELETE", `/accounts/${accountId}/workers/domains/${domainId}`);
  }
}
