// Shapes of the THS dashboard API (crates/ths-server/src/api). Numbers are zatoshi unless named otherwise.

export type Pool = 'ironwood' | 'transparent';
export type MiningMode = 'auto' | 'interval' | 'mempool' | 'manual';
export type AccountId = 1 | 2 | 3 | 4 | 5;

/** Host addresses of one running instance, as `ths endpoints --json` reports them. */
export interface Endpoints {
  /** Dashboard HTTP API base URL (`THS_API_URL`). */
  apiUrl: string;
  /** Zakura JSON-RPC URL (`THS_ZAKURA_RPC_URL`). */
  rpcUrl: string;
  /** Plaintext lightwalletd gRPC URL (`THS_LIGHTWALLETD_URL`). */
  lightwalletdUrl: string;
  /** Loopback peer `host:port` (`THS_P2P_ADDR`). */
  p2pAddr: string;
}

export interface THSConfig extends Endpoints {
  name: string;
  network: 'regtest';
  lightwalletdTls: false;
  miningMode: MiningMode;
  blockTime: number | null;
}

export interface ChainInfo {
  blocks: number;
  bestblockhash: string;
  [key: string]: unknown;
}

export interface WalletSync {
  state: string;
  fully_scanned_height: number | null;
  fully_scanned_hash: string | null;
  observed_height: number | null;
  observed_hash: string | null;
  last_success_at: number | null;
  error: string | null;
}

export interface Status {
  instance: string;
  node: ChainInfo | null;
  account_count: number;
  mining_mode: MiningMode;
  auto_mine: boolean;
  block_time: number | null;
  mine_on_mempool: boolean;
  network: string;
  endpoints: { dashboard: string; zakura_rpc: string; lightwalletd: string; p2p: string };
  wallet_sync: WalletSync;
  settled: boolean;
  settlement_blocker: string | null;
  [key: string]: unknown;
}

export interface Account {
  id: number;
  name: string;
  unified_address: string;
  transparent_address: string;
  unified_full_viewing_key?: string;
  transparent_zatoshi: number;
  ironwood_zatoshi: number;
}

export type PaymentStatus = 'preparing' | 'prepared' | 'broadcast' | 'unconfirmed' | 'confirmed' | 'failed';

export interface Activity {
  id: string;
  kind: string;
  direction: string;
  from_account: number | null;
  to_account: number | null;
  from_accounts: number[];
  to_accounts: number[];
  to_address: string | null;
  recipient_addresses: string[];
  source_pool: Pool | null;
  destination_pool: Pool | null;
  amount_zatoshi: number;
  txid: string;
  block_hash: string | null;
  mined_height: number | null;
  confirmations: number;
  status: PaymentStatus;
  created_at: string | null;
  memos: string[];
  last_error: string | null;
  [key: string]: unknown;
}

export interface AddressFaucetResult {
  address: string;
  amount_zatoshi: number;
  txid: string;
  block_hash: string | null;
  status: PaymentStatus;
  last_error: string | null;
}

export interface SendQuote {
  available_zatoshi: number;
  fee_zatoshi: number;
  max_zatoshi: number;
}

export interface MineResult {
  blocks: number;
  hashes: string[];
}

export interface ChainChangeResult {
  [key: string]: unknown;
}

export interface WalletOutput {
  pool: Pool;
  index: number;
  value_zatoshi: number;
  from: number | 'faucet' | null;
  to: number | 'faucet' | null;
  to_address: string | null;
  change: boolean;
  memo: { text: string } | { hex: string } | null;
}

export interface WalletTransaction {
  txid: string;
  status: 'pending' | 'confirmed';
  mined_height: number | null;
  confirmations: number;
  fee_zatoshi: number | null;
  details: 'complete' | 'pending' | 'unavailable';
  outputs: WalletOutput[];
  spends: unknown[];
}

export interface ParsedPaymentUri {
  address: string;
  destination_pool: Pool;
  to_account: number | null;
  amount_zatoshi: number | null;
  memo: string | null;
}

export type EventTopic = 'wallet' | 'chain' | 'sync' | 'mining' | 'resync';

export interface THSEvent {
  topic: EventTopic;
}
