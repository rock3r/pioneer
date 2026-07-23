import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { diagnosticMessage } from "../diagnostics.js";
import type { EvalPlatform } from "./isolation.js";
import { LINUX_BWRAP_INSTALL_PATH, resolveLinuxBwrapPath } from "./linux-install.js";

export const WINDOWS_STRICT_ISOLATION_ERROR = diagnosticMessage(
  "WINDOWS_STRICT_ISOLATION_UNAVAILABLE",
  "Strict eval filesystem isolation is unavailable on Windows: no stable AppContainer launcher is available. No actor was started.",
);

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function strictEvalReadinessErrors(
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (!(["darwin", "linux", "win32"] as NodeJS.Platform[]).includes(platform)) {
    return [
      diagnosticMessage(
        "EVAL_PLATFORM_UNSUPPORTED",
        `Strict eval isolation is unsupported on ${platform}`,
      ),
    ];
  }
  if (platform === "win32") return [WINDOWS_STRICT_ISOLATION_ERROR];
  if (platform !== "linux") return [];

  let restrictedUserNamespaces = false;
  try {
    restrictedUserNamespaces =
      (await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")).trim() ===
      "1";
  } catch {
    // This AppArmor knob is Ubuntu-specific. Other distributions can use bwrap directly.
  }
  if (restrictedUserNamespaces && !(await executable(LINUX_BWRAP_INSTALL_PATH))) {
    return [
      diagnosticMessage(
        "LINUX_USER_NAMESPACE_RESTRICTED",
        "Ubuntu restricts capability-bearing unprivileged user namespaces. Run `npm run build`, then `sudo node dist/eval-run-cli.js install-linux`, to install the dedicated AppArmor-confined sandbox executables.",
      ),
    ];
  }
  if ((await resolveLinuxBwrapPath()) === undefined) {
    return [
      diagnosticMessage(
        "BUBBLEWRAP_NOT_FOUND",
        "Linux sandboxing requires Bubblewrap (`bwrap`) to be installed.",
      ),
    ];
  }
  return [];
}

export async function assertStrictEvalReady(
  platform: EvalPlatform = process.platform as EvalPlatform,
): Promise<void> {
  const errors = await strictEvalReadinessErrors(platform);
  if (errors.length > 0) throw new Error(errors.join("; "));
}
