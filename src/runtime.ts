import type { Endpoints, MiningMode } from './types.ts';
import { THSError } from './errors.ts';

export interface StartOptions {
  /** Instance name; must not collide with a running instance. */
  name: string;
  /** Mining mode for the instance's lifetime. Default `auto`. */
  mining: MiningMode;
  /** Seconds between empty blocks; required for `interval`. */
  blockTime?: number;
  /** Host port offset (multiple of 10). Undefined lets the runtime pick a free block. */
  portOffset?: number;
  /** Milliseconds to wait for startup and settlement. */
  timeoutMs: number;
  /** Receives runtime log lines (launcher stdout/stderr). */
  onLog?: (line: string) => void;
}

/** A running instance as seen by its runtime. */
export interface Instance {
  name: string;
  endpoints: Endpoints;
  /** Stop and delete the instance. Idempotent. A no-op for instances the runtime does not own. */
  stop(): Promise<void>;
}

/**
 * How an instance is brought up. Today THS ships one way (the `ths` launcher, which uses Docker);
 * a Docker-free runtime with prebuilt binaries plugs in here without changing the client API.
 */
export interface Runtime {
  readonly kind: string;
  start(options: StartOptions): Promise<Instance>;
}

/** The JSON `ths endpoints --json` prints. */
export interface RawEndpoints {
  dashboard: string;
  rpc: string;
  lightwalletd: string;
  p2p: string;
  network: string;
  tls: boolean;
}

export function parseEndpoints(raw: RawEndpoints): Endpoints {
  if (raw.network !== 'regtest') {
    throw new THSError(`refusing to use a non-regtest instance (network: ${raw.network})`);
  }
  return { apiUrl: trimSlash(raw.dashboard), rpcUrl: raw.rpc, lightwalletdUrl: raw.lightwalletd, p2pAddr: raw.p2p };
}

/** Use an instance something else started (another terminal, CI service). Stopping it is left to its owner. */
export function attachRuntime(target: Partial<Endpoints> & { apiUrl: string }): Runtime {
  return {
    kind: 'attach',
    async start({ name }) {
      const api = trimSlash(target.apiUrl);
      const status = await fetch(`${api}/api/v1/status`).then(async (res) => {
        if (!res.ok) throw new THSError(`cannot reach THS at ${api}: HTTP ${res.status}`);
        return (await res.json()) as { instance: string; network: string; endpoints: Record<string, string> };
      });
      if (status.network.toLowerCase() !== 'regtest') {
        throw new THSError(`refusing to use a non-regtest instance (network: ${status.network})`);
      }
      return {
        name: status.instance ?? name,
        endpoints: {
          apiUrl: api,
          rpcUrl: target.rpcUrl ?? status.endpoints.zakura_rpc ?? '',
          lightwalletdUrl: target.lightwalletdUrl ?? status.endpoints.lightwalletd ?? '',
          p2pAddr: target.p2pAddr ?? status.endpoints.p2p ?? '',
        },
        async stop() {},
      };
    },
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
