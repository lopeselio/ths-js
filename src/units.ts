export const ZATOSHI_PER_ZEC = 100_000_000n;

/** Exact ZEC → zatoshi: `zec('1.5') === 150000000n`. Takes a decimal string to avoid float rounding. */
export function zec(amount: string | bigint): bigint {
  if (typeof amount === 'bigint') return amount * ZATOSHI_PER_ZEC;
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(amount.trim());
  if (!match) throw new RangeError(`not a ZEC amount with at most 8 decimals: ${amount}`);
  const [, whole = '0', frac = ''] = match;
  return BigInt(whole) * ZATOSHI_PER_ZEC + BigInt(frac.padEnd(8, '0'));
}

/** Zatoshi → decimal ZEC string, trailing zeros trimmed. */
export function formatZec(zatoshi: bigint | number): string {
  const value = BigInt(zatoshi);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const frac = (abs % ZATOSHI_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${abs / ZATOSHI_PER_ZEC}${frac ? `.${frac}` : ''}`;
}

/** The API takes u64 zatoshi as JSON numbers; refuse anything that would lose precision. */
export function toApiZatoshi(amount: bigint | number): number {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`zatoshi amount out of range: ${amount}`);
  }
  return Number(value);
}
