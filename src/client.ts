import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Account,
  AccountId,
  Activity,
  AddressFaucetResult,
  ChainChangeResult,
  MineResult,
  MiningMode,
  ParsedPaymentUri,
  PaymentStatus,
  Pool,
  SendQuote,
  Status,
  THSConfig,
  THSEvent,
  WalletTransaction,
} from './types.ts';
import type { Instance, Runtime } from './runtime.ts';
import { attachRuntime } from './runtime.ts';
import { cliRuntime } from './cli-runtime.ts';
import { THSApiError, THSError, THSRpcError, THSTimeoutError } from './errors.ts';
import { toApiZatoshi } from './units.ts';

export interface TestTHSClientOptions {
  /** Instance name. Default `js-<random>`, so parallel test files never collide. */
  name?: string;
  /** Mining mode. Default `auto`: every payment mines its own confirming block. */
  mining?: MiningMode;
  /** Seconds between blocks for `interval` mining. */
  blockTime?: number;
  /** Fixed host port offset (multiple of 10). Default: first free block. */
  portOffset?: number;
  /** Startup + settlement timeout in ms. Default 300 s (the first run pulls images). */
  startTimeoutMs?: number;
  /** How to run the instance. Default: the `ths` launcher. */
  runtime?: Runtime;
  /** Attach to an already-running instance instead of starting one. `stop()` then leaves it running. */
  attach?: { apiUrl: string };
  /** Receives runtime log lines. */
  onLog?: (line: string) => void;
}

export type Amount = bigint | number;
type WaitFor = 'accepted' | 'confirmed';

export interface FaucetParams {
  /** Development account (1–5) or a regtest address. */
  to: AccountId | string;
  /** Zatoshi. Use `zec('1')` for ZEC. */
  amount: Amount;
  /** Pool for an account recipient. Default `ironwood`. Ignored for addresses. */
  pool?: Pool;
  idempotencyKey?: string;
  /** Default: `confirmed` in auto mining, `accepted` otherwise (blocks are then up to you). */
  waitFor?: WaitFor;
}

export interface SendParams {
  from: AccountId;
  /** Development account (1–5) or a regtest address. */
  to: AccountId | string;
  amount: Amount;
  memo?: string;
  /** Default `ironwood`. */
  fromPool?: Pool;
  /** Default `ironwood`, or `transparent` for a `tm…` address. */
  toPool?: Pool;
  idempotencyKey?: string;
  waitFor?: WaitFor;
}

function idempotencyKey(key?: string): string {
  if (key === undefined) return randomUUID();
  if (key.length < 8 || key.length > 128) throw new RangeError('idempotencyKey must contain 8-128 characters');
  return key;
}

const SEED_CONFIRMATION = 'I understand this seed is for regtest only';
const FINAL: PaymentStatus[] = ['confirmed', 'failed'];

export type TestTHSClient = ReturnType<typeof createTestTHSClient>;

/**
 * A disposable Zcash regtest network for tests.
 *
 * ```ts
 * const ths = createTestTHSClient();
 * await ths.start();
 * const config = ths.config();
 * await ths.produceBlock(10);
 * await ths.stop();
 * ```
 */
export function createTestTHSClient(options: TestTHSClientOptions = {}) {
  const runtime = options.runtime ?? (options.attach ? attachRuntime(options.attach) : cliRuntime());
  const name = options.name ?? `js-${randomBytes(6).toString('hex')}`;
  let instance: Instance | undefined;
  let starting: Promise<THSConfig> | undefined;
  let cfg: THSConfig | undefined;

  const api = () => {
    if (!cfg) throw new THSError('THS is not started; await ths.start() first');
    return cfg.apiUrl;
  };

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${api()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message = (json as { error?: { message?: string } } | null)?.error?.message ?? (text || res.statusText);
      throw new THSApiError(`${method} ${path}`, res.status, message);
    }
    return json as T;
  }
  const get = <T>(path: string) => request<T>('GET', path);
  const post = <T>(path: string, body: unknown) => request<T>('POST', path, body);

  async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new THSTimeoutError(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const defaultWait = (): WaitFor => (cfg?.miningMode === 'auto' ? 'confirmed' : 'accepted');

  const client = {
    /** Start (or attach to) the instance and wait until node, lightwalletd and wallet agree. Idempotent. */
    async start(): Promise<THSConfig> {
      starting ??= (async () => {
        instance = await runtime.start({
          name,
          mining: options.mining ?? 'auto',
          blockTime: options.blockTime,
          portOffset: options.portOffset,
          timeoutMs: options.startTimeoutMs ?? 300_000,
          onLog: options.onLog,
        });
        cfg = {
          name: instance.name,
          network: 'regtest',
          lightwalletdTls: false,
          miningMode: options.mining ?? 'auto',
          blockTime: options.blockTime ?? null,
          ...instance.endpoints,
        };
        const status = await client.waitForSettled();
        // THS ≤ 0.4.1 reports only `auto_mine`; `mining_mode` arrived later.
        cfg.miningMode = status.mining_mode ?? (status.auto_mine ? 'auto' : cfg.miningMode);
        cfg.blockTime = status.block_time ?? cfg.blockTime;
        return { ...cfg };
      })();
      try {
        return await starting;
      } catch (err) {
        starting = undefined;
        throw err;
      }
    },

    /** Stop and delete the instance (chain, keys, containers). Safe to call twice. */
    async stop(): Promise<void> {
      const current = instance;
      instance = undefined;
      starting = undefined;
      cfg = undefined;
      await current?.stop();
    },

    async [Symbol.asyncDispose]() {
      await client.stop();
    },

    /** Endpoints and settings of the running instance; feed `rpcUrl` / `lightwalletdUrl` to zcash.js. */
    config(): THSConfig {
      api();
      return { ...cfg! };
    },

    /** Same variables `ths run` gives its child (`THS_API_URL`, …), for spawning tools under test. */
    env(): Record<string, string> {
      const c = client.config();
      return {
        THS_INSTANCE: c.name,
        THS_NETWORK: 'regtest',
        THS_API_URL: c.apiUrl,
        THS_ZAKURA_RPC_URL: c.rpcUrl,
        THS_LIGHTWALLETD_URL: c.lightwalletdUrl,
        THS_LIGHTWALLETD_TLS: 'false',
        THS_P2P_ADDR: c.p2pAddr,
      };
    },

    // ── chain ────────────────────────────────────────────────────────────

    /** Mine `blocks` (1–10,000) and wait for the wallet to sync them. */
    produceBlock(blocks = 1): Promise<MineResult> {
      if (!Number.isInteger(blocks) || blocks < 1 || blocks > 10_000) {
        throw new RangeError('blocks must be an integer between 1 and 10,000');
      }
      return post<MineResult>('/api/v1/mine', { blocks });
    },

    /** Alias of produceBlock. */
    mine(blocks = 1): Promise<MineResult> {
      return client.produceBlock(blocks);
    },

    /** Replace the last `depth` blocks with new ones. */
    reorg(depth: number, opts: { keepTxs?: boolean } = {}): Promise<ChainChangeResult> {
      return post('/api/v1/reorg', { depth, keep_txs: opts.keepTxs ?? false });
    },

    /** Remove the last `depth` blocks without replacements. */
    rollback(depth: number): Promise<ChainChangeResult> {
      return post('/api/v1/rollback', { depth });
    },

    async getBlockNumber(): Promise<number> {
      return client.rpc<number>('getblockcount');
    },

    /** Raw Zakura JSON-RPC. */
    async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
      const res = await fetch(client.config().rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } | null };
      if (body.error) throw new THSRpcError(method, body.error.code, body.error.message);
      if (!res.ok) throw new THSRpcError(method, res.status, res.statusText);
      return body.result as T;
    },

    // ── status ───────────────────────────────────────────────────────────

    getStatus: () => get<Status>('/api/v1/status'),

    async isHealthy(): Promise<boolean> {
      const res = await fetch(`${api()}/api/v1/health`).catch(() => undefined);
      return res?.ok ?? false;
    },

    /** Wait until node, lightwalletd and wallet are settled at the same tip. */
    waitForSettled(opts: { timeoutMs?: number } = {}): Promise<Status> {
      return poll(
        () => client.getStatus().catch(() => undefined),
        (s) => !!s && s.settled && s.wallet_sync.state === 'ready',
        'settlement',
        opts.timeoutMs ?? 120_000,
      ) as Promise<Status>;
    },

    // ── accounts ─────────────────────────────────────────────────────────

    getAccounts: () => get<Account[]>('/api/v1/accounts'),

    async getAccount(id: AccountId): Promise<Account> {
      const account = (await client.getAccounts()).find((a) => a.id === id);
      if (!account) throw new THSError(`no development account ${id}`);
      return account;
    },

    async getBalance(id: AccountId): Promise<{ ironwood: bigint; transparent: bigint; total: bigint }> {
      const a = await client.getAccount(id);
      const ironwood = BigInt(a.ironwood_zatoshi);
      const transparent = BigInt(a.transparent_zatoshi);
      return { ironwood, transparent, total: ironwood + transparent };
    },

    /** Raw development seed (hex). Regtest only; never reuse it anywhere real. */
    async getSeed(): Promise<string> {
      return (await post<{ seed_hex: string }>('/api/v1/dev/seed', { confirmation: SEED_CONFIRMATION })).seed_hex;
    },

    // ── payments ─────────────────────────────────────────────────────────

    /** Fund an account or address from the treasury. */
    async faucet(params: FaucetParams): Promise<Activity | AddressFaucetResult> {
      const key = idempotencyKey(params.idempotencyKey);
      const amount_zatoshi = toApiZatoshi(params.amount);
      const waitFor = params.waitFor ?? defaultWait();
      if (typeof params.to === 'number') {
        const accepted = await post<Activity>('/api/v1/faucet', {
          account_id: params.to,
          pool: params.pool ?? 'ironwood',
          amount_zatoshi,
          idempotency_key: key,
        });
        return waitFor === 'confirmed' ? client.waitForPayment(key) : accepted;
      }
      const accepted = await post<AddressFaucetResult>('/api/v1/faucet/address', {
        address: params.to,
        amount_zatoshi,
        idempotency_key: key,
      });
      if (waitFor !== 'confirmed') return accepted;
      return finalOrThrow(
        await poll(
          () => get<AddressFaucetResult>(`/api/v1/faucet/address?idempotency_key=${encodeURIComponent(key)}`),
          (r) => FINAL.includes(r.status),
          `faucet ${key}`,
          120_000,
        ),
      );
    },

    /** Pay from a development account to another account or a regtest address. */
    async send(params: SendParams): Promise<Activity> {
      const key = idempotencyKey(params.idempotencyKey);
      const toAddress = typeof params.to === 'string';
      const accepted = await post<Activity>('/api/v1/send', {
        from_account: params.from,
        to_account: toAddress ? undefined : params.to,
        to_address: toAddress ? params.to : undefined,
        source_pool: params.fromPool ?? 'ironwood',
        destination_pool: params.toPool ?? (toAddress && /^tm/.test(params.to as string) ? 'transparent' : 'ironwood'),
        amount_zatoshi: toApiZatoshi(params.amount),
        idempotency_key: key,
        memo: params.memo,
      });
      return (params.waitFor ?? defaultWait()) === 'confirmed' ? client.waitForPayment(key) : accepted;
    },

    /** Spendable amount, fee and max for one account and pool pair. Moves nothing. */
    quote(params: { from: AccountId; fromPool?: Pool; toPool?: Pool }): Promise<SendQuote> {
      return post('/api/v1/send/quote', {
        from_account: params.from,
        source_pool: params.fromPool ?? 'ironwood',
        destination_pool: params.toPool ?? 'ironwood',
      });
    },

    /** One payment's stored activity, or undefined. */
    async getPayment(idempotencyKey: string): Promise<Activity | undefined> {
      const [entry] = await get<Activity[]>(`/api/v1/activity?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
      return entry;
    },

    /** Poll a payment until it is confirmed; throws if it fails. Mine blocks yourself in manual mode. */
    async waitForPayment(idempotencyKey: string, opts: { timeoutMs?: number } = {}): Promise<Activity> {
      const entry = await poll(
        () => client.getPayment(idempotencyKey),
        (a) => !!a && FINAL.includes(a.status),
        `payment ${idempotencyKey}`,
        opts.timeoutMs ?? 120_000,
      );
      const settled = finalOrThrow(entry!);
      // A lookup by key returns a compact record (no memos, pools per account); the feed has the full one.
      const full = (await client.getActivity()).find((a) => a.txid === settled.txid);
      return { ...full, ...settled, ...(full && { memos: full.memos }) } as Activity;
    },

    getActivity: (opts: { limit?: number } = {}) =>
      get<Activity[]>(`/api/v1/activity${opts.limit ? `?limit=${opts.limit}` : ''}`),

    // ── transactions & explorer ──────────────────────────────────────────

    /** What the development wallet recorded about a tx: outputs, memos, change, fee. */
    getWalletTransaction(txid: string, opts: { account?: AccountId } = {}): Promise<WalletTransaction> {
      const query = opts.account ? `?account=${opts.account}` : '';
      return get(`/api/v1/transactions/${txid}/wallet${query}`);
    },

    getTransaction: (txid: string) => get<Record<string, unknown>>(`/api/v1/transactions/${txid}`),
    getBlock: (id: number | string) => get<Record<string, unknown>>(`/api/v1/blocks/${id}`),
    getMempool: () => get<unknown>('/api/v1/mempool'),
    decodeTransaction: (hex: string) => post<Record<string, unknown>>('/api/v1/transactions/decode', { hex }),

    // ── ZIP-321 ──────────────────────────────────────────────────────────

    parsePaymentUri: (uri: string) => post<ParsedPaymentUri>('/api/v1/zip321/parse', { uri }),

    async createPaymentUri(params: { account: AccountId; amount?: Amount; memo?: string }): Promise<string> {
      const body = {
        account_id: params.account,
        amount_zatoshi: params.amount === undefined ? undefined : toApiZatoshi(params.amount),
        memo: params.memo,
      };
      return (await post<{ uri: string }>('/api/v1/zip321/request', body)).uri;
    },

    // ── events ───────────────────────────────────────────────────────────

    /**
     * Server-sent change hints. Each event names a topic to refetch; it is not a payload.
     * `for await (const e of ths.watchEvents({ signal })) …`
     */
    async *watchEvents(opts: { signal?: AbortSignal } = {}): AsyncGenerator<THSEvent> {
      const res = await fetch(`${api()}/api/v1/events`, {
        headers: { accept: 'text/event-stream' },
        signal: opts.signal,
      });
      if (!res.ok || !res.body) throw new THSApiError('GET /api/v1/events', res.status, res.statusText);
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary: number;
          while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
            const event = parseFrame(frame);
            if (event) yield event;
          }
        }
      } catch (err) {
        if (opts.signal?.aborted) return;
        throw err;
      }
    },
  };

  return client;
}

function finalOrThrow<T extends { status: PaymentStatus; last_error: string | null; txid: string }>(entry: T): T {
  if (entry.status === 'failed') throw new THSError(`payment ${entry.txid || ''} failed: ${entry.last_error ?? 'unknown'}`);
  return entry;
}

function parseFrame(frame: string): THSEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  // The server sends the bare topic name as data (state.rs `notify`).
  if (event !== 'update' || data.length === 0) return undefined;
  return { topic: data.join('\n') as THSEvent['topic'] };
}
