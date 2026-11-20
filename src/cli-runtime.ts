import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Instance, RawEndpoints, Runtime, StartOptions } from './runtime.ts';
import { parseEndpoints } from './runtime.ts';
import { THSError, THSTimeoutError } from './errors.ts';

export interface CliRuntimeOptions {
  /** Path to the `ths` launcher. Default: `$THS_BIN`, then `ths` on PATH, then `~/.local/bin/ths`. */
  bin?: string;
  /** Milliseconds to wait for Ctrl+C cleanup before killing the launcher. Default 120 s. */
  stopTimeoutMs?: number;
  /** Run THS's local binaries instead of Docker (`ths start --native`). Default: `THS_NATIVE=1`. */
  native?: boolean;
  /** Native runtime bundle. Default: the launcher's own choice (`THS_RUNTIME_DIR`, then its installed bundle). */
  runtimeDir?: string;
}

// Default host ports; `--port-offset` shifts all four as a block (book/connect-an-app.md).
const BASE_PORTS = [32805, 18232, 18233, 9067];
const LOG_TAIL = 60;

/** Runs instances through the installed `ths` launcher (`ths start`), in Docker or natively. */
export function cliRuntime(options: CliRuntimeOptions = {}): Runtime {
  const bin = options.bin ?? resolveBin();
  const stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
  const native = options.native ?? process.env.THS_NATIVE === '1';

  return {
    kind: 'cli',
    async start(start) {
      // Native startup allocates free loopback ports itself when the offset is zero.
      const portOffset = start.portOffset ?? (native ? 0 : await findPortOffset());
      const args = ['--name', start.name, 'start', '--no-open', '--port-offset', String(portOffset)];
      if (native) {
        // The launcher bounds native startup itself and defaults to 180 s, below our own default.
        args.push('--native', '--timeout', String(Math.ceil(start.timeoutMs / 1000)));
        if (options.runtimeDir) args.push('--runtime-dir', options.runtimeDir);
      }
      args.push(...miningArgs(start));
      const tail: string[] = [];
      const log = (line: string) => {
        tail.push(line);
        if (tail.length > LOG_TAIL) tail.shift();
        start.onLog?.(line);
      };

      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      pipeLines(child, log);
      // A spawn failure emits 'error' and no 'exit'; treat it as an exit so stop() never hangs.
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.once('error', () => resolve(-1));
      });
      let exitCode: number | null | undefined;
      void exited.then((code) => (exitCode = code));
      const spawnError = new Promise<never>((_, reject) =>
        child.once('error', (err) => reject(new THSError(`cannot run ${bin}: ${err.message}. Install THS or set THS_BIN.`))),
      );
      spawnError.catch(() => {});

      // Clean up on parent exit even when the caller forgets to stop().
      const onExit = () => child.kill('SIGINT');
      process.once('exit', onExit);

      let stopping: Promise<void> | undefined;
      const stop = () =>
        (stopping ??= (async () => {
          process.removeListener('exit', onExit);
          let interrupted = false;
          if (exitCode === undefined) {
            interrupted = child.kill('SIGINT');
            const timer = setTimeout(() => child.kill('SIGKILL'), stopTimeoutMs);
            exitCode = await exited;
            clearTimeout(timer);
          }
          // The native launcher reports our SIGINT as 128 + 2, and only after verified cleanup;
          // a cleanup failure exits 1. The Docker launcher exits 0.
          if (exitCode !== 0 && !(native && interrupted && exitCode === 130)) {
            throw new THSError(`ths cleanup for ${start.name} exited with ${exitCode}:\n${tail.join('\n')}`);
          }
        })());

      try {
        const ready = waitReady(bin, start.name, start.timeoutMs, () => exitCode !== undefined);
        const endpoints = await Promise.race([ready, spawnError]);
        return { name: start.name, endpoints, stop };
      } catch (err) {
        await stop().catch(() => {});
        const detail = exitCode !== undefined ? `\nths exited with ${exitCode}:\n${tail.join('\n')}` : '';
        if (err instanceof Error) err.message += detail;
        throw err;
      }
    },
  };
}

async function waitReady(bin: string, name: string, timeoutMs: number, launcherExited: () => boolean) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  // `ths wait` fails fast when no launcher has registered the instance yet, so retry until ours has.
  while (Date.now() < deadline) {
    if (launcherExited()) throw new THSError(`ths start for ${name} exited before it was ready`);
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    let raw: RawEndpoints;
    try {
      await run(bin, ['--name', name, 'wait', '--timeout', String(seconds), '--json']);
      raw = JSON.parse(await run(bin, ['--name', name, 'endpoints', '--json'])) as RawEndpoints;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await delay(1000);
      continue;
    }
    return parseEndpoints(raw);
  }
  throw new THSTimeoutError(`instance ${name} was not settled within ${timeoutMs} ms. Last error: ${lastError}`);
}

function miningArgs({ mining, blockTime }: StartOptions): string[] {
  switch (mining) {
    case 'auto':
      return [];
    case 'manual':
      return ['--no-auto-mine'];
    case 'mempool':
      return ['--mine-on-mempool'];
    case 'interval':
      if (!blockTime || blockTime < 1 || !Number.isInteger(blockTime)) {
        throw new THSError('interval mining needs a positive integer blockTime (seconds)');
      }
      return ['--block-time', String(blockTime)];
  }
}

/** The first offset whose four ports are all free on loopback. Racy by nature; pass portOffset to pin it. */
export async function findPortOffset(max = 2000): Promise<number> {
  for (let offset = 0; offset <= max; offset += 10) {
    const free = await Promise.all(BASE_PORTS.map((port) => isPortFree(port + offset)));
    if (free.every(Boolean)) return offset;
  }
  throw new THSError(`no free THS port block within offset ${max}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export function resolveBin(): string {
  if (process.env.THS_BIN) return process.env.THS_BIN;
  const installed = join(process.env.THS_INSTALL_DIR ?? join(homedir(), '.local', 'bin'), 'ths');
  const onPath = (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, 'ths')));
  return !onPath && existsSync(installed) ? installed : 'ths';
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new THSError(`ths ${args.join(' ')}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

function pipeLines(child: ChildProcess, log: (line: string) => void) {
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log(line);
    });
    stream?.on('end', () => buffered.trim() && log(buffered));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
