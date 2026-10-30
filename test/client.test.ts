import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTHSClient, zec, formatZec, THSApiError, THSRpcError, THSError } from '../src/index.ts';
import { startMockTHS, type MockTHS } from './mock-ths.ts';

describe('createTestTHSClient against a mock dashboard', () => {
  let mock: MockTHS;
  let ths: ReturnType<typeof createTestTHSClient>;

  before(async () => {
    mock = await startMockTHS();
    ths = createTestTHSClient({ attach: { apiUrl: `${mock.url}/` } });
    await ths.start();
  });
  after(async () => {
    await ths.stop();
    await mock.close();
  });

  it('reports config from the instance status', () => {
    const config = ths.config();
    assert.equal(config.apiUrl, mock.url);
    assert.equal(config.rpcUrl, `${mock.url}/rpc`);
    assert.equal(config.network, 'regtest');
    assert.equal(config.miningMode, 'auto');
    assert.equal(ths.env().THS_API_URL, mock.url);
  });

  it('produces blocks', async () => {
    const before = await ths.getBlockNumber();
    const result = await ths.produceBlock(10);
    assert.equal(result.blocks, 10);
    assert.equal(await ths.getBlockNumber(), before + 10);
    assert.throws(() => ths.produceBlock(0), RangeError);
  });

  it('reads balances as bigint', async () => {
    const balance = await ths.getBalance(1);
    assert.equal(balance.ironwood, zec('5'));
    assert.equal(balance.total, 500_000_000n);
  });

  it('funds an account and waits for confirmation in auto mode', async () => {
    const result = await ths.faucet({ to: 2, amount: zec('1'), pool: 'transparent' });
    assert.equal(result.status, 'confirmed');
    const req = mock.requests.find((r) => r.path === '/api/v1/faucet');
    assert.deepEqual({ ...(req?.body as object), idempotency_key: 'x' }, {
      account_id: 2,
      pool: 'transparent',
      amount_zatoshi: 100_000_000,
      idempotency_key: 'x',
    });
  });

  it('funds an external address', async () => {
    const result = await ths.faucet({ to: 'uregtest1external', amount: 1234n });
    assert.equal(result.status, 'confirmed');
  });

  it('sends with a memo and infers pools', async () => {
    const payment = await ths.send({ from: 1, to: 'tmSomeone', amount: 5000n, memo: 'order 42', idempotencyKey: 'k1' });
    assert.equal(payment.status, 'confirmed');
    assert.deepEqual(payment.memos, ['order 42']);
    const body = mock.requests.find((r) => r.path === '/api/v1/send')?.body as Record<string, unknown>;
    assert.equal(body.destination_pool, 'transparent');
    assert.equal(body.to_address, 'tmSomeone');
    assert.equal(body.to_account, undefined);
  });

  it('surfaces API errors with status and message', async () => {
    await assert.rejects(ths.getWalletTransaction('nope'), (err: unknown) => {
      assert.ok(err instanceof THSApiError);
      assert.equal(err.status, 404);
      return true;
    });
  });

  it('surfaces JSON-RPC errors', async () => {
    await assert.rejects(ths.rpc('nosuchmethod'), THSRpcError);
  });

  it('builds payment URIs and reads the seed', async () => {
    assert.match(await ths.createPaymentUri({ account: 2, amount: zec('0.5') }), /^zcash:uregtest1acct2\?amount=0.5$/);
    assert.equal(await ths.getSeed(), '00'.repeat(32));
  });

  it('streams change events until aborted', async () => {
    const controller = new AbortController();
    const topics: string[] = [];
    const reading = (async () => {
      for await (const event of ths.watchEvents({ signal: controller.signal })) {
        topics.push(event.topic);
        if (topics.length === 2) controller.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    mock.emit('wallet');
    await ths.produceBlock(1);
    await reading;
    assert.deepEqual(topics, ['wallet', 'chain']);
  });
});

describe('payment edge cases', () => {
  it('throws when a payment fails', async () => {
    const mock = await startMockTHS({ failPayments: true });
    const ths = createTestTHSClient({ attach: { apiUrl: mock.url } });
    await ths.start();
    try {
      await assert.rejects(ths.send({ from: 1, to: 2, amount: 1n }), /failed: insufficient funds/);
    } finally {
      await ths[Symbol.asyncDispose]();
      await mock.close();
    }
  });

  it('returns the accepted payment without waiting in manual mining', async () => {
    const mock = await startMockTHS({ miningMode: 'manual' });
    const ths = createTestTHSClient({ attach: { apiUrl: mock.url } });
    await ths.start();
    assert.equal(ths.config().miningMode, 'manual');
    const accepted = await ths.send({ from: 1, to: 2, amount: 1n, idempotencyKey: 'm1' });
    assert.equal(accepted.status, 'broadcast');
    assert.equal((await ths.waitForPayment('m1')).status, 'confirmed');
    await mock.close();
  });

  it('refuses calls before start', () => {
    const ths = createTestTHSClient({ attach: { apiUrl: 'http://127.0.0.1:1' } });
    assert.throws(() => ths.config(), THSError);
  });

  it('rejects unsafe amounts', async () => {
    const mock = await startMockTHS();
    const ths = createTestTHSClient({ attach: { apiUrl: mock.url } });
    await ths.start();
    await assert.rejects(ths.send({ from: 1, to: 2, amount: 2n ** 60n }), RangeError);
    await mock.close();
  });
});

describe('units', () => {
  it('converts exactly', () => {
    assert.equal(zec('1.5'), 150_000_000n);
    assert.equal(zec('0.00000001'), 1n);
    assert.equal(zec(3n), 300_000_000n);
    assert.throws(() => zec('0.000000001'), RangeError);
    assert.throws(() => zec('1e3'), RangeError);
    assert.equal(formatZec(150_000_000n), '1.5');
    assert.equal(formatZec(1), '0.00000001');
    assert.equal(formatZec(-200_000_000n), '-2');
  });
});

describe('older THS servers', () => {
  it('derives auto mining from auto_mine when mining_mode is absent (THS 0.4.1)', async () => {
    const mock = await startMockTHS({ legacyStatus: true });
    const ths = createTestTHSClient({ attach: { apiUrl: mock.url } });
    await ths.start();
    try {
      assert.equal(ths.config().miningMode, 'auto');
      assert.equal((await ths.send({ from: 1, to: 2, amount: 1n })).status, 'confirmed');
    } finally {
      await mock.close();
    }
  });
});
