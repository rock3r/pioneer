import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, chown, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";

export const LINUX_INSTALL_DIR = "/usr/local/libexec/pioneer";
export const LINUX_BWRAP_INSTALL_PATH = `${LINUX_INSTALL_DIR}/bwrap`;
export const LINUX_APPARMOR_PROFILE_PATH = "/etc/apparmor.d/pioneer-bwrap";

export const LINUX_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

# Grant user namespaces only to Pioneer's root-owned Bubblewrap copy.
profile pioneer-bwrap ${LINUX_BWRAP_INSTALL_PATH} flags=(unconfined) {
  userns,
}
`;

const SYSTEM_BWRAP_PATH = "/usr/bin/bwrap";

async function executableOrUndefined(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

export async function resolveLinuxBwrapPath(): Promise<string | undefined> {
  return (
    (await executableOrUndefined(LINUX_BWRAP_INSTALL_PATH)) ??
    (await executableOrUndefined(SYSTEM_BWRAP_PATH))
  );
}

export async function installLinuxSandboxSupport(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("install-linux must run as root on Linux");
  }
  await access(SYSTEM_BWRAP_PATH, constants.X_OK).catch(() => {
    throw new Error("install-linux requires Ubuntu's /usr/bin/bwrap package executable");
  });
  await access("/sbin/apparmor_parser", constants.X_OK).catch(() => {
    throw new Error("install-linux requires AppArmor and /sbin/apparmor_parser");
  });

  await mkdir(LINUX_INSTALL_DIR, { recursive: true, mode: 0o755 });
  await copyFile(SYSTEM_BWRAP_PATH, LINUX_BWRAP_INSTALL_PATH);
  await Promise.all([
    chown(LINUX_INSTALL_DIR, 0, 0),
    chown(LINUX_BWRAP_INSTALL_PATH, 0, 0),
    chmod(LINUX_INSTALL_DIR, 0o755),
    chmod(LINUX_BWRAP_INSTALL_PATH, 0o755),
  ]);
  await writeFile(LINUX_APPARMOR_PROFILE_PATH, LINUX_APPARMOR_PROFILE, { mode: 0o644 });
  await chown(LINUX_APPARMOR_PROFILE_PATH, 0, 0);
  await chmod(LINUX_APPARMOR_PROFILE_PATH, 0o644);
  execFileSync("/sbin/apparmor_parser", ["-r", LINUX_APPARMOR_PROFILE_PATH], {
    stdio: "inherit",
  });
}
