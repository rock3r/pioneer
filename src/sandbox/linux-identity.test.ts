import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerManagedTempPaths } from "../../test/support/temp-dir.js";
import { buildLinuxSandboxArgv } from "./launcher.js";
import { stageLinuxIdentity } from "./linux-identity.js";

const { createTempDir } = registerManagedTempPaths();

describe("synthetic Linux identity", () => {
  it("binds only synthetic passwd and group records for root and the active identity", async () => {
    const scratch = await createTempDir("pioneer-linux-identity-");
    const identity = await stageLinuxIdentity(scratch, "/private-home", 1234, 5678);
    expect(await readFile(identity.passwd, "utf8")).toBe(
      "root:x:0:0:root:/root:/bin/false\npioneer:x:1234:5678::/private-home:/bin/false\n",
    );
    expect(await readFile(identity.group, "utf8")).toBe("root:x:0:\npioneer:x:5678:\n");
    const { argv } = buildLinuxSandboxArgv(
      { readOnlyPaths: [], writablePaths: [], network: "none", linuxIdentity: identity },
      ["/bin/true"],
      "/usr/bin/bwrap",
    );
    expect(argv.join("\0")).toContain(`--ro-bind\0${identity.passwd}\0/etc/passwd`);
    expect(argv.join("\0")).toContain(`--ro-bind\0${identity.group}\0/etc/group`);
  });

  it("emits one root entry when the sandbox actor uses UID and GID zero", async () => {
    const scratch = await createTempDir("pioneer-linux-root-identity-");
    const identity = await stageLinuxIdentity(scratch, "/private-home", 0, 0);
    expect(await readFile(identity.passwd, "utf8")).toBe(
      "root:x:0:0:root:/private-home:/bin/false\n",
    );
    expect(await readFile(identity.group, "utf8")).toBe("root:x:0:\n");
  });
});
