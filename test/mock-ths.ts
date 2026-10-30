// An in-memory stand-in for the THS dashboard API, enough to exercise the client without Docker.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Payment {
  key: string;
  body: Record<string, unknown>;
  status: string;
  polls: number;
}

export interface MockTHS {
  url: string;
  height: number;
  requests: { method: string; path: string; body: unknown }[];
  payments: Map<string, Payment>;
  emit(topic: string): void;
  close(): Promise<void>;
}

export async function startMockTHS(opts: { miningMode?: string; failPayments?: boolean; legacyStatus?: boolean } = {}): Promise<MockTHS> {
  const sse = new Set<ServerResponse>();
  const accounts = [1, 2, 3, 4, 5].map((id) => ({
    id,
    name: `Account ${id}`,
    unified_address: `uregtest1acct${id}`,
    transparent_address: `tmAcct${id}`,
    unified_full_viewing_key: `uviewregtest1acct${id}`,
    ironwood_zatoshi: id === 1 ? 500_000_000 : 0,
    transparent_zatoshi: 0,
  }));

  const state: MockTHS = {
    url: '',
    height: 101,
    requests: [],
    payments: new Map(),
    emit(topic) {
      for (const res of sse) res.write(`event: update\ndata: ${topic}\n\n`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const res of sse) res.end();
        server.close(() => resolve());
      }),
  };

  const activity = (p: Payment) => ({
    id: p.key,
    kind: p.body.account_id ? 'faucet' : 'send',
    direction: 'outgoing',
    from_account: p.body.from_account ?? null,
    to_account: p.body.to_account ?? p.body.account_id ?? null,
    amount_zatoshi: p.body.amount_zatoshi,
    txid: `tx-${p.key}`,
    status: p.status,
    memos: p.body.memo ? [p.body.memo] : [],
    last_error: p.status === 'failed' ? 'insufficient funds' : null,
  });

  // A payment confirms on its second status read, as if a block landed in between.
  const advance = (p: Payment) => {
    if (p.status === 'broadcast' && ++p.polls >= 2) p.status = opts.failPayments ? 'failed' : 'confirmed';
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, message: string) => send(res, status, { error: { message, status } });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', state.url);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
    const route = `${req.method} ${url.pathname}`;

    if (url.pathname === '/rpc') {
      if (body.method === 'getblockcount') return send(res, 200, { jsonrpc: '2.0', id: body.id, result: state.height });
      return send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }

    switch (route) {
      case 'GET /api/v1/health':
        return send(res, 200, { ok: true });
      case 'GET /api/v1/status':
        return send(res, 200, {
          instance: 'mock',
          node: { blocks: state.height, bestblockhash: 'ab'.repeat(32) },
          account_count: 5,
          mining_mode: opts.legacyStatus ? undefined : (opts.miningMode ?? 'auto'),
          auto_mine: (opts.miningMode ?? 'auto') === 'auto',
          block_time: null,
          mine_on_mempool: false,
          network: 'Regtest',
          endpoints: { dashboard: state.url, zakura_rpc: `${state.url}/rpc`, lightwalletd: 'http://127.0.0.1:9067', p2p: '127.0.0.1:18233' },
          wallet_sync: { state: 'ready', fully_scanned_height: state.height },
          settled: true,
          settlement_blocker: null,
        });
      case 'GET /api/v1/accounts':
        return send(res, 200, accounts);
      case 'POST /api/v1/mine': {
        if (!(body.blocks >= 1 && body.blocks <= 10_000)) return fail(res, 400, 'blocks must be between 1 and 10,000');
        state.height += body.blocks;
        state.emit('chain');
        return send(res, 200, { blocks: body.blocks, hashes: Array.from({ length: body.blocks }, (_, i) => `h${i}`) });
      }
      case 'POST /api/v1/faucet':
      case 'POST /api/v1/send':
      case 'POST /api/v1/faucet/address': {
        if (!body.idempotency_key) return fail(res, 400, 'idempotency_key is required');
        const p: Payment = { key: body.idempotency_key, body, status: 'broadcast', polls: 0 };
        state.payments.set(p.key, p);
        if (route === 'POST /api/v1/faucet/address') {
          return send(res, 202, { address: body.address, amount_zatoshi: body.amount_zatoshi, txid: `tx-${p.key}`, block_hash: null, status: p.status, last_error: null });
        }
        return send(res, 202, activity(p));
      }
      case 'GET /api/v1/faucet/address': {
        const p = state.payments.get(url.searchParams.get('idempotency_key') ?? '');
        if (!p) return fail(res, 404, 'not found');
        advance(p);
        return send(res, 200, { address: p.body.address, amount_zatoshi: p.body.amount_zatoshi, txid: `tx-${p.key}`, block_hash: null, status: p.status, last_error: null });
      }
      case 'GET /api/v1/activity': {
        const key = url.searchParams.get('idempotency_key');
        const list = [...state.payments.values()].filter((p) => !key || p.key === key);
        list.forEach(advance);
        return send(res, 200, list.map(activity));
      }
      case 'POST /api/v1/send/quote':
        return send(res, 200, { available_zatoshi: 500_000_000, fee_zatoshi: 10_000, max_zatoshi: 499_990_000 });
      case 'POST /api/v1/reorg':
      case 'POST /api/v1/rollback':
        return send(res, 200, { depth: body.depth });
      case 'POST /api/v1/zip321/request':
        return send(res, 200, { uri: `zcash:uregtest1acct${body.account_id}?amount=${(body.amount_zatoshi ?? 0) / 1e8}` });
      case 'POST /api/v1/dev/seed':
        if (body.confirmation !== 'I understand this seed is for regtest only') return fail(res, 400, 'exact confirmation phrase required');
        return send(res, 200, { seed_hex: '00'.repeat(32) });
      case 'GET /api/v1/events':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
    }
    return fail(res, 404, `no route ${route}`);
  }

  const server = createServer((req, res) => void handle(req, res).catch((err) => fail(res, 500, String(err))));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}
