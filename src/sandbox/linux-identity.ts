import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface LinuxSandboxIdentity {
  readonly passwd: string;
  readonly group: string;
}

export async function stageLinuxIdentity(
  controllerDir: string,
  homeDir: string,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
): Promise<LinuxSandboxIdentity> {
  if (uid === undefined || gid === undefined)
    throw new Error("Linux sandbox identity requires a user and group ID");
  // Keep unusual but valid paths from affecting the passwd record layout.
  const home = /[:\r\n\0]/u.test(homeDir) ? "/" : homeDir;
  const identity = {
    passwd: path.join(controllerDir, "sandbox-passwd"),
    group: path.join(controllerDir, "sandbox-group"),
  };
  const passwd =
    uid === 0
      ? `root:x:0:${gid}:root:${home}:/bin/false\n`
      : `root:x:0:0:root:/root:/bin/false\npioneer:x:${uid}:${gid}::${home}:/bin/false\n`;
  const group = `root:x:0:\n${gid === 0 ? "" : `pioneer:x:${gid}:\n`}`;
  // Wait for both writes before the caller can clean up their parent on failure.
  const result = await Promise.allSettled([
    writeFile(identity.passwd, passwd, { flag: "wx", mode: 0o400 }),
    writeFile(identity.group, group, { flag: "wx", mode: 0o400 }),
  ]);
  const failure = result.find((entry) => entry.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return identity;
}
