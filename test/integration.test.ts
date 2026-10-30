// End-to-end against a real THS instance. Needs the `ths` launcher (and, for now, Docker).
// Run with `npm run test:integration`; skipped otherwise.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTHSClient, zec, THSApiError } from '../src/index.ts';

const enabled = process.env.THS_INTEGRATION === '1';

describe('real THS instance', { skip: !enabled && 'set THS_INTEGRATION=1' }, () => {
  const ths = createTestTHSClient({ onLog: (line) => process.env.THS_VERBOSE && console.error(`[ths] ${line}`) });

  before(async () => {
    await ths.start();
  });
  after(async () => {
    await ths.stop();
  });

  it('starts settled on regtest with funded account 1', async () => {
    const config = ths.config();
    assert.equal(config.network, 'regtest');
    assert.match(config.apiUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(await ths.isHealthy());
    assert.equal((await ths.getBalance(1)).ironwood, zec('5'));
  });

  it('produces blocks', async () => {
    const before = await ths.getBlockNumber();
    const { hashes } = await ths.produceBlock(10);
    assert.equal(hashes.length, 10);
    assert.equal(await ths.getBlockNumber(), before + 10);
  });

  it('funds and sends with a memo the recipient wallet can read', async () => {
    await ths.faucet({ to: 2, amount: zec('1'), pool: 'transparent' });
    const payment = await ths.send({ from: 1, to: 3, amount: zec('0.1'), memo: 'order 42' });
    assert.equal(payment.status, 'confirmed');
    assert.deepEqual(payment.memos, ['order 42']);
  });

  it('reads outputs and memos the recipient wallet recorded', async (t) => {
    const payment = await ths.send({ from: 1, to: 4, amount: zec('0.1'), memo: 'order 43' });
    let tx;
    try {
      tx = await ths.getWalletTransaction(payment.txid, { account: 4 });
    } catch (err) {
      // Route added after THS 0.4.1 (zcashlabs/thus-spoke-zakura#430).
      if (err instanceof THSApiError && err.status === 404) return t.skip('THS release predates /transactions/{txid}/wallet');
      throw err;
    }
    const received = tx.outputs.find((o) => o.to === 4 && !o.change);
    assert.equal(received?.value_zatoshi, 10_000_000);
    assert.deepEqual(received?.memo, { text: 'order 43' });
  });

  it('round-trips a ZIP-321 request', async () => {
    const uri = await ths.createPaymentUri({ account: 4, amount: zec('0.25'), memo: 'invoice 7' });
    const parsed = await ths.parsePaymentUri(uri);
    assert.equal(parsed.to_account, 4);
    assert.equal(parsed.amount_zatoshi, 25_000_000);
    assert.equal(parsed.memo, 'invoice 7');
  });

  it('survives a reorg', async () => {
    const before = await ths.getBlockNumber();
    await ths.reorg(3);
    await ths.waitForSettled();
    assert.ok((await ths.getBlockNumber()) >= before);
  });
});
