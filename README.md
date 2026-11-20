# ths-js

Run [Thus Spoke Zakura](https://github.com/zcashlabs/thus-spoke-zakura) from code: start a disposable Zcash
regtest network, fund accounts, send, mine, reorg, and tear it down, all from your test suite.

```ts
import { createTestTHSClient, zec } from 'ths-js';

const ths = createTestTHSClient();
await ths.start();                 // starts Zakura + lightwalletd + wallet, waits until settled
let config = ths.config();         // { apiUrl, rpcUrl, lightwalletdUrl, p2pAddr, network: 'regtest', ... }
await ths.produceBlock(10);

await ths.faucet({ to: 2, amount: zec('1') });
const tx = await ths.send({ from: 1, to: 3, amount: zec('0.1'), memo: 'order 42' });
const seen = await ths.getWalletTransaction(tx.txid, { account: 3 });

await ths.stop();                  // deletes the instance's chain, keys and containers
```

`createTestTHSClient` mirrors the `create*Client` naming of [zcash.js](https://github.com/zcashlabs/zcashjs):
point zcash.js at `config.rpcUrl` / `config.lightwalletdUrl` to test a real light client against regtest.

> Regtest only. Development keys are public and fixed. Never send real funds to these addresses.

## Requirements

- Node 22.18+
- The `ths` launcher (`curl -fsSL https://raw.githubusercontent.com/zcashlabs/thus-spoke-zakura/main/install.sh | sh`)
  and either a running Docker engine or THS's native runtime.

THS can run without Docker since [thus-spoke-zakura#452](https://github.com/zcashlabs/thus-spoke-zakura/pull/452).
Set `THS_NATIVE=1` (or `cliRuntime({ native: true })`) to start instances with `ths start --native`. The launcher
finds its runtime bundle through `THS_RUNTIME_DIR` (or `cliRuntime({ runtimeDir })`), then its installed bundle. A
native instance starts and settles in seconds. Native bundles aren't in a THS release yet; until they are, build one
from source as described in THS's `RELEASING.md`.

> zcash.js is adding an official equivalent of this package, `@zcashlabs/zcash.js/testing`
> ([zcashjs#26](https://github.com/zcashlabs/zcashjs/issues/26)). Prefer it once it is released.

Tested against THS 0.4.1 (Docker) and the native runtime on THS `main`. The launcher is found via `THS_BIN`, then `ths` on `PATH`, then `~/.local/bin/ths`.

## Test-runner setup

```ts
// vitest / node:test / jest
let ths: TestTHSClient;
beforeAll(async () => { ths = createTestTHSClient(); await ths.start(); }, 300_000);
afterAll(() => ths.stop());
```

Each client gets its own instance name and the first free port block, so test files can run in parallel.
On Node 24+, `await using ths = createTestTHSClient()` stops it automatically.

To reuse an instance you already started with `ths` in another terminal (much faster for local iteration):

```ts
const ths = createTestTHSClient({ attach: { apiUrl: 'http://127.0.0.1:32805' } });
```

`stop()` leaves an attached instance running.

## Options

| Option | Default | |
|---|---|---|
| `name` | `js-<random>` | Instance name |
| `mining` | `'auto'` | `'auto'` (each payment mines its block), `'manual'`, `'mempool'`, `'interval'` |
| `blockTime` | — | Seconds per block for `'interval'` |
| `portOffset` | first free block | Multiple of 10 added to all four host ports |
| `startTimeoutMs` | `300000` | Startup + settlement (first run pulls images) |
| `runtime` | `cliRuntime()` | How instances are started; see below |
| `attach` | — | `{ apiUrl }` of a running instance |
| `onLog` | — | Launcher output, line by line |

## API

| Method | |
|---|---|
| `start()` / `stop()` | Lifecycle; both idempotent |
| `config()` / `env()` | Endpoints; `env()` gives the `THS_*` variables `ths run` passes to children |
| `produceBlock(n)` / `mine(n)` | Mine 1–10,000 blocks and wait for wallet sync |
| `reorg(depth, { keepTxs })` / `rollback(depth)` | Chain reorganisation testing |
| `getBlockNumber()` / `rpc(method, params)` | Zakura JSON-RPC |
| `getStatus()` / `isHealthy()` / `waitForSettled()` | Readiness |
| `getAccounts()` / `getAccount(id)` / `getBalance(id)` | Development accounts 1–5 (balances as `bigint`) |
| `faucet({ to, amount, pool? })` | Fund an account or regtest address |
| `send({ from, to, amount, memo?, fromPool?, toPool? })` | Pay an account or address |
| `quote({ from, fromPool?, toPool? })` | Available / fee / max, moves nothing |
| `getPayment(key)` / `waitForPayment(key)` / `getActivity()` | Payment status |
| `getWalletTransaction(txid, { account })` | Outputs, memos, change, fee as the wallet recorded them (THS after 0.4.1) |
| `getTransaction` / `getBlock` / `getMempool` / `decodeTransaction` | Explorer |
| `createPaymentUri` / `parsePaymentUri` | ZIP-321 |
| `watchEvents({ signal })` | Async iterator of `{ topic }` change hints |
| `getSeed()` | Raw dev seed (regtest only) |

Amounts are zatoshi (`bigint` or safe-integer `number`); `zec('1.5')` converts exactly, `formatZec()` goes back.

Payments wait for confirmation by default in `auto` mining. In other modes they return once accepted, so
mine blocks yourself and then call `waitForPayment(key)`. Override this with `waitFor: 'accepted' | 'confirmed'`.

## Runtimes

A `Runtime` turns `{ name, mining, portOffset, ... }` into a running instance with endpoints and a `stop()`.

- `cliRuntime({ bin })` (default) spawns `ths --name <n> start --no-open`, polls `ths wait` / `ths endpoints`,
  and stops with SIGINT so THS runs its own bounded cleanup.
- `attachRuntime({ apiUrl })` uses an existing instance.
- The native runtime (no Docker) is the same `cliRuntime` with `native: true`.

## Develop

```sh
npm install
npm test                 # unit tests: mock dashboard + fake launcher, no Docker
npm run test:integration # real THS (needs ths + Docker, or THS_NATIVE=1)
npm run build
```
