import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The POSIX launcher that Pi's managed installer (`pi.dev/install.sh`) writes to
 * `<agent>/bin/pi`. It reads `install/current-version` and runs that release's npm bin.
 */
export const MANAGED_PI_LAUNCHER = `#!/bin/sh
case "$0" in
  */*) pi_launcher="$0" ;;
  *) pi_launcher=$(command -v "$0") || exit 127 ;;
esac
while [ -L "$pi_launcher" ]; do
  pi_link=$(readlink "$pi_launcher") || exit 1
  case "$pi_link" in
    /*) pi_launcher="$pi_link" ;;
    *) pi_launcher=\${pi_launcher%/*}/$pi_link ;;
  esac
done
pi_bin_dir=\${pi_launcher%/*}
pi_agent_dir=\${pi_bin_dir%/*}
pi_current_file=$pi_agent_dir/install/current-version
if ! IFS= read -r pi_current_version < "$pi_current_file"; then
  printf 'Could not read managed Pi version from %s.\\n' "$pi_current_file" >&2
  exit 1
fi
case "$pi_current_version" in
  ""|.|..|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._+-]*)
    printf 'Managed Pi version file is invalid: %s\\n' "$pi_current_file" >&2
    exit 1
    ;;
esac
pi_release_dir=$pi_agent_dir/install/releases/$pi_current_version
pi_release_bin=$pi_release_dir/node_modules/.bin/pi
if [ ! -x "$pi_release_bin" ]; then
  printf 'Managed Pi executable is missing: %s\\n' "$pi_release_bin" >&2
  exit 1
fi
pi_node_bin=\${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin
if [ -x "$pi_node_bin/node" ]; then
  PATH=$pi_node_bin:$PATH
  export PATH
fi
PI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install
export PI_MANAGED_INSTALL_ROOT
exec "$pi_release_bin" "$@"
`;

export interface ManagedPiInstall {
  /** `<agent>`: the directory that holds `bin/` and `install/`. */
  readonly agentDir: string;
  /** `<agent>/bin`, the launcher directory placed on PATH. */
  readonly binDir: string;
  /** `<agent>/install`, Pi's `PI_MANAGED_INSTALL_ROOT`. */
  readonly installRoot: string;
  /** `<agent>/install/releases/<version>/node_modules`. */
  readonly releaseNodeModules: string;
  /** The official package directory inside the release. */
  readonly packageRoot: string;
  /** The package's declared `pi` entry point. */
  readonly entryPoint: string;
}

/**
 * Builds the managed-installer layout: a marker, `current-version`, the launcher, and one
 * release whose npm-hoisted dependencies sit beside the Pi package.
 */
export async function createManagedPiInstall(
  agentDir: string,
  options: { readonly version?: string; readonly marker?: string | null } = {},
): Promise<ManagedPiInstall> {
  const version = options.version ?? "1.5.2";
  const binDir = path.join(agentDir, "bin");
  const installRoot = path.join(agentDir, "install");
  const releaseNodeModules = path.join(installRoot, "releases", "1.5.2", "node_modules");
  const packageRoot = path.join(releaseNodeModules, "@earendil-works", "pi-coding-agent");
  const entryPoint = path.join(packageRoot, "dist", "cli.js");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(path.join(releaseNodeModules, ".bin"), { recursive: true });
  await mkdir(path.join(releaseNodeModules, "chalk"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
  );
  await writeFile(entryPoint, "#!/usr/bin/env node\nconsole.log('1.5.2');\n");
  await chmod(entryPoint, 0o755);
  await symlink(
    "../@earendil-works/pi-coding-agent/dist/cli.js",
    path.join(releaseNodeModules, ".bin", "pi"),
  );
  await writeFile(path.join(releaseNodeModules, "chalk", "package.json"), '{"name":"chalk"}');
  await writeFile(path.join(installRoot, "current-version"), `${version}\n`);
  if (options.marker !== null) {
    await writeFile(
      path.join(installRoot, "managed-install.json"),
      options.marker ??
        JSON.stringify({
          kind: "pi-managed-install",
          schemaVersion: 1,
          layout: "releases-v1",
          entrypoint: { type: "launcher", path: path.join(binDir, "pi") },
        }),
    );
  }
  await writeFile(path.join(binDir, "pi"), MANAGED_PI_LAUNCHER);
  await chmod(path.join(binDir, "pi"), 0o755);
  return { agentDir, binDir, installRoot, releaseNodeModules, packageRoot, entryPoint };
}
