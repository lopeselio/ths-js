# THS without Docker: proposal

Goal (from the THS Discord thread): `npm i ths` and `createTestTHSClient().start()` should work on a machine with
no Docker, the way Foundry's `anvil` is a single prebuilt binary.

## What Docker runs today

From `thus-spoke-zakura` (`crates/ths-cli/src/runtime`, `Dockerfile`, `docker/lightwalletd.Dockerfile`):

| Service | Image | What it is | Native build |
|---|---|---|---|
| `zakura` | `zakuracore/zakura:1.7.0` | Full node, regtest | Rust; prebuilt per-platform binary |
| `lightwalletd` | `ghcr.io/zcashlabs/thus-spoke-zakura-lightwalletd` | `zcash/lightwalletd` @ pinned commit | Go, `CGO_ENABLED=0`: trivially cross-compiles to static binaries |
| `app` | `ghcr.io/zcashlabs/thus-spoke-zakura-app` | `ths-server` (Rust) + built dashboard (`/opt/ths/web`) | Rust binary; dashboard assets can be embedded with `include_dir`/`rust-embed` |
| `init` | app image | Generates config, keys, volumes | Becomes a function in the launcher |

Docker also provides: a private network with aliases (`zakura`, `lightwalletd`), volumes per instance, port
publishing, and container-label-based cleanup. Each needs a native replacement.

## Proposal

1. **Release artifacts.** CI already builds the images. Also publish per-target tarballs
   (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`)
   containing `zakurad`, `lightwalletd` and `ths-server` (with embedded dashboard), plus `SHA256SUMS` signed the
   same way `ths update` verifies releases today.
2. **`ths start --runtime native`** in the launcher:
   - data under `$THS_CONFIG_DIR/instances/<name>/{zakura,lightwalletd,app}` instead of volumes;
   - processes spawned as children in one process group, with ports `base + offset` on `127.0.0.1` (the four ports
     and `--port-offset` stay the same, so `ths endpoints` output does not change);
   - in-network hostnames (`zakura:18232`) replaced by loopback addresses passed through config/env
     (`THS_PUBLIC_*` vars already exist in `ths-server`);
   - cleanup = kill the process group + delete the instance dir; keep `lifecycle-recovery.json` semantics
     (record PIDs instead of container IDs).
3. **Make native the default** once it is at parity; keep `--runtime docker` for Windows and CI images.
4. **npm distribution, the esbuild/turbo pattern:** `ths` (this package) + optional deps
   `@ths/darwin-arm64`, `@ths/linux-x64`, … each carrying the binaries. `npm i` pulls only the matching one, so no
   postinstall download, no curl|sh, and versions are locked by `package-lock.json`.

## Where this package fits

The client only depends on the `Runtime` interface (`src/runtime.ts`):

```ts
interface Runtime { start(opts: StartOptions): Promise<{ name; endpoints; stop() }> }
```

A `nativeRuntime()` can either
- call `ths start --runtime native` (smallest change: all lifecycle logic stays in Rust), or
- spawn the three binaries from the platform npm package directly (no launcher at all).

The first is the recommended path: one implementation of lifecycle, cleanup and recovery, shared by the CLI and
every language binding. Either way, client code and tests do not change.

## Open questions for maintainers

- Is Zakura licensed and built so per-platform binaries can be redistributed in THS releases?
- macOS: are Zakura's and lightwalletd's regtest data dirs and ports fine without a container's filesystem isolation?
- Should `ths-server` gain a `--serve-dashboard-from-embedded` mode, or keep the dashboard optional for headless tests?
