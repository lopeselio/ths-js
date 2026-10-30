import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestTHSClient, cliRuntime, findPortOffset, THSError } from '../src/index.ts';
import { startMockTHS, type MockTHS } from './mock-ths.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-ths.sh', import.meta.url));

describe('cliRuntime driving a fake ths launcher', () => {
  let mock: MockTHS;
  let dir: string;

  before(async () => {
    mock = await startMockTHS();
    dir = mkdtempSync(join(tmpdir(), 'ths-js-'));
    process.env.FAKE_THS_API = mock.url;
    process.env.FAKE_THS_STATE = join(dir, 'instance');
    process.env.FAKE_THS_LOG = join(dir, 'calls.log');
  });
  after(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts, waits, exposes endpoints, and stops with SIGINT cleanup', async () => {
    const logs: string[] = [];
    const ths = createTestTHSClient({
      name: 'unit',
      mining: 'manual',
      portOffset: 20,
      runtime: cliRuntime({ bin: FAKE }),
      onLog: (line) => logs.push(line),
    });
    const config = await ths.start();
    assert.equal(config.name, 'unit');
    assert.equal(config.apiUrl, mock.url);
    assert.equal((await ths.produceBlock(10)).blocks, 10);

    const calls = readFileSync(process.env.FAKE_THS_LOG!, 'utf8');
    assert.match(calls, /^--name unit start --no-open --port-offset 20 --no-auto-mine$/m);
    assert.match(calls, /^--name unit wait --timeout \d+ --json$/m);

    await ths.stop();
    await ths.stop();
    assert.ok(!existsSync(`${process.env.FAKE_THS_STATE}.unit`), 'launcher ran its cleanup');
    assert.ok(logs.includes('Deleting unit'));
  });

  it('reports launcher output when start fails', async () => {
    process.env.FAKE_THS_START_FAIL = '1';
    try {
      const ths = createTestTHSClient({ runtime: cliRuntime({ bin: FAKE }), portOffset: 0, startTimeoutMs: 5000 });
      await assert.rejects(ths.start(), /port 32805 is already in use/);
    } finally {
      delete process.env.FAKE_THS_START_FAIL;
    }
  });

  it('fails stop() when cleanup fails', async () => {
    process.env.FAKE_THS_STOP_CODE = '3';
    try {
      const ths = createTestTHSClient({ name: 'dirty', runtime: cliRuntime({ bin: FAKE }), portOffset: 0 });
      await ths.start();
      await assert.rejects(ths.stop(), /cleanup for dirty exited with 3/);
    } finally {
      delete process.env.FAKE_THS_STOP_CODE;
    }
  });

  it('refuses a non-regtest instance', async () => {
    process.env.FAKE_THS_NETWORK = 'mainnet';
    try {
      const ths = createTestTHSClient({ name: 'main', runtime: cliRuntime({ bin: FAKE }), portOffset: 0, startTimeoutMs: 3000 });
      await assert.rejects(ths.start(), THSError);
    } finally {
      delete process.env.FAKE_THS_NETWORK;
    }
  });

  it('explains a missing launcher', async () => {
    const ths = createTestTHSClient({ runtime: cliRuntime({ bin: join(dir, 'missing-ths') }), portOffset: 0 });
    await assert.rejects(ths.start(), /Install THS or set THS_BIN/);
  });

  it('finds a free port block', async () => {
    const offset = await findPortOffset();
    assert.equal(offset % 10, 0);
  });
});
