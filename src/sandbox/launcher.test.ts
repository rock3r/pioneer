import { describe, expect, it } from "vitest";
import { buildLinuxSandboxArgv, buildMacosSandboxArgv } from "./launcher.js";

const policy = {
  readOnlyPaths: ["/repo", "/repo/.idea", "/repo/.vscode", "/usr"],
  writablePaths: ["/scratch"],
  network: "proxy" as const,
  proxyUrl: "http://pioneer:secret@127.0.0.1:43123",
};

describe("direct sandbox launchers", () => {
  it("generates a macOS profile from only caller-provided grants", () => {
    const launch = buildMacosSandboxArgv(policy, ["/usr/bin/node", "actor.mjs"]);
    expect(launch.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(launch.profile).toContain('(allow file-read* (subpath "/repo/.idea"))');
    expect(launch.profile).toContain('(allow file-read* (subpath "/repo/.vscode"))');
    expect(launch.profile).toContain('(allow file-read-metadata (literal "/repo"))');
    expect(launch.profile).not.toContain("(allow file-read-metadata)\n");
    expect(launch.profile).not.toContain("dangerous");
    expect(launch.profile).toContain('(allow network-outbound (remote ip "localhost:43123"))');
    expect(launch.argv.slice(-2)).toEqual(["/usr/bin/node", "actor.mjs"]);
  });

  it("lets macOS actors open /dev/null for ignored stdio and Git (#86, #87)", () => {
    const launch = buildMacosSandboxArgv(policy, ["/usr/bin/node", "actor.mjs"]);
    // libuv's posix_spawn opens /dev/null for every "ignore" stdio slot, and Git opens
    // it read-write; an ioctl-only grant made both fail with EPERM.
    expect(launch.profile).toContain('(allow file-read* file-write* (literal "/dev/null"))');
    expect(launch.profile).not.toContain('(allow file-write* (literal "/dev/zero"))');
    expect(launch.profile).not.toMatch(/\(allow file-write\* \(subpath "\/dev"\)\)/);
  });

  it("lets macOS resolve the /var alias for grants under /private/var (#87)", () => {
    const launch = buildMacosSandboxArgv(
      { ...policy, readOnlyPaths: [...policy.readOnlyPaths, "/private/var/select"] },
      ["/usr/bin/node", "actor.mjs"],
    );
    // xcode-select reads /var/select/developer_dir, which traverses the root /var symlink.
    expect(launch.profile).toContain('(allow file-read* (literal "/var"))');
    expect(launch.profile).not.toContain('(literal "/etc")');
    expect(launch.profile).not.toContain('(literal "/tmp")');
    expect(launch.profile).not.toContain('(subpath "/var")');
  });

  it("adds no private-alias rule without a grant beneath it", () => {
    const launch = buildMacosSandboxArgv(policy, ["/usr/bin/node", "actor.mjs"]);
    expect(launch.profile).not.toContain('(literal "/var")');
  });

  it("opens only the allowed macOS loopback ports and sends loopback traffic direct (#88)", () => {
    const launch = buildMacosSandboxArgv({ ...policy, loopbackPorts: [8722, 8723] }, [
      "/usr/bin/node",
      "actor.mjs",
    ]);
    expect(launch.profile).toContain('(allow network-outbound (remote ip "localhost:8722"))');
    expect(launch.profile).toContain('(allow network-outbound (remote ip "localhost:8723"))');
    expect(launch.profile).toContain('(allow network-outbound (remote ip "localhost:43123"))');
    expect(launch.profile).not.toContain('(remote ip "localhost:*")');
    expect(launch.environment.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(launch.environment.no_proxy).toBe("127.0.0.1,localhost");
  });

  it("keeps every destination behind the proxy when no loopback port is allowed", () => {
    const launch = buildMacosSandboxArgv(policy, ["/usr/bin/node", "actor.mjs"]);
    expect(launch.environment.NO_PROXY).toBe("");
    expect(launch.profile.match(/network-outbound/g)).toHaveLength(1);
  });

  it.each([0, 65_536, 1.5, Number.NaN])("rejects an invalid loopback port: %s", (port) => {
    expect(() =>
      buildMacosSandboxArgv({ ...policy, loopbackPorts: [port] }, ["/usr/bin/true"]),
    ).toThrow(/loopback port/i);
  });

  it("relays allowed Linux loopback ports through bound Unix sockets (#88)", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, loopbackPorts: [8722] },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
      "/scratch/egress.sock",
      undefined,
      [{ port: 8722, socketPath: "/bridge/loopback-8722.sock" }],
    );
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        "/bridge/loopback-8722.sock",
        "/bridge/loopback-8722.sock",
      ]),
    );
    const supervisor = launch.argv.findLastIndex((entry) =>
      entry.endsWith("linux-network-supervisor.js"),
    );
    expect(launch.argv.slice(supervisor + 1)).toEqual([
      "/scratch/egress.sock",
      "--loopback",
      "8722:/bridge/loopback-8722.sock",
      "/usr/bin/node",
      "actor.mjs",
    ]);
    expect(launch.environment.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  it("refuses a Linux loopback port without its relay socket", () => {
    expect(() =>
      buildLinuxSandboxArgv(
        { ...policy, loopbackPorts: [8722] },
        ["/usr/bin/node", "actor.mjs"],
        "/usr/bin/bwrap",
        "/scratch/egress.sock",
      ),
    ).toThrow(/relay socket/i);
    expect(() =>
      buildLinuxSandboxArgv(
        { ...policy, loopbackPorts: [3128] },
        ["/usr/bin/node", "actor.mjs"],
        "/usr/bin/bwrap",
        "/scratch/egress.sock",
        undefined,
        [{ port: 3128, socketPath: "/bridge/loopback-3128.sock" }],
      ),
    ).toThrow(/3128/);
  });

  it("builds a Linux rootless mount namespace without exposing the host root", () => {
    const launch = buildLinuxSandboxArgv(
      policy,
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
      "/scratch/egress.sock",
    );
    expect(launch.argv[0]).toBe("/usr/bin/bwrap");
    expect(launch.argv).toContain("--unshare-user");
    expect(launch.argv).toContain("--unshare-pid");
    expect(launch.argv).toContain("--unshare-net");
    expect(launch.argv.join("\0")).not.toContain("--ro-bind\0/\0/");
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--ro-bind", "/repo/.idea", "/repo/.idea"]),
    );
    expect(launch.argv).toEqual(expect.arrayContaining(["--bind", "/scratch", "/scratch"]));
    expect(launch.argv).not.toContain("/bin/sh");
    expect(launch.argv.some((entry) => entry.endsWith("linux-network-supervisor.js"))).toBe(true);
  });

  it("leaves session creation to the detached capture process", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none" },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
    );
    expect(launch.argv).not.toContain("--new-session");
  });

  it("leaves networking absent when the policy is offline", () => {
    const offline = {
      readOnlyPaths: policy.readOnlyPaths,
      writablePaths: policy.writablePaths,
      network: "none" as const,
    };
    const mac = buildMacosSandboxArgv(offline, ["/usr/bin/true"]);
    const linux = buildLinuxSandboxArgv(offline, ["/usr/bin/true"], "/usr/bin/bwrap");
    expect(mac.profile).not.toContain("network-outbound");
    expect(linux.argv).toContain("--unshare-net");
  });

  it("binds only the Linux runtime executable", () => {
    const runtime = "/opt/node/bin/node";
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none", readOnlyPaths: [...policy.readOnlyPaths, runtime] },
      [runtime, runtime, "actor.mjs"],
      "/usr/bin/bwrap",
      undefined,
      runtime,
    );

    expect(launch.argv.slice(-3)).toEqual([runtime, runtime, "actor.mjs"]);
    expect(launch.argv).toEqual(expect.arrayContaining(["--ro-bind", runtime, runtime]));
    expect(
      launch.argv.some(
        (entry, index) => entry === "--ro-bind" && launch.argv[index + 1] === runtime,
      ),
    ).toBe(true);
  });

  it("restores canonical Linux runtime linker aliases inside the empty root", () => {
    const launch = buildLinuxSandboxArgv(
      {
        ...policy,
        network: "none",
        readOnlyPaths: ["/repo", "/usr", "/usr/lib", "/usr/lib64"],
      },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
    );

    expect(launch.argv).toEqual(expect.arrayContaining(["--symlink", "usr/lib", "/lib"]));
    expect(launch.argv).toEqual(expect.arrayContaining(["--symlink", "usr/lib64", "/lib64"]));
  });

  it("restores /bin when usrmerge canonicalizes it to usr/bin, so /bin/sh resolves", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none", readOnlyPaths: ["/repo", "/usr", "/usr/bin"] },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
    );

    expect(launch.argv).toEqual(expect.arrayContaining(["--symlink", "usr/bin", "/bin"]));
  });

  it("does not alias /bin when a lexical path beneath it is granted", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none", readOnlyPaths: ["/repo", "/usr", "/usr/bin", "/bin/sh"] },
      ["/bin/sh", "-c", "true"],
      "/usr/bin/bwrap",
    );

    // Bubblewrap would otherwise try to create --dir /bin on top of the alias symlink.
    expect(launch.argv.join("\0")).not.toContain("--symlink\0usr/bin\0/bin");
    expect(launch.argv).toEqual(expect.arrayContaining(["--ro-bind", "/bin/sh", "/bin/sh"]));
  });

  it("keeps a real /bin mount instead of aliasing it", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none", readOnlyPaths: ["/repo", "/usr", "/usr/bin", "/bin"] },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
    );

    expect(launch.argv.join("\0")).not.toContain("--symlink\0usr/bin\0/bin");
    expect(launch.argv).toEqual(expect.arrayContaining(["--ro-bind", "/bin", "/bin"]));
  });

  it("restores lib64 when usrmerge canonicalizes it to usr/lib", () => {
    const launch = buildLinuxSandboxArgv(
      { ...policy, network: "none", readOnlyPaths: ["/repo", "/usr", "/usr/lib"] },
      ["/usr/bin/node", "actor.mjs"],
      "/usr/bin/bwrap",
    );

    expect(launch.argv).toEqual(expect.arrayContaining(["--symlink", "usr/lib", "/lib64"]));
  });

  it("can prohibit child-process creation for a controller-owned review", () => {
    const launch = buildMacosSandboxArgv({ ...policy, allowProcessFork: false }, [
      "/usr/bin/node",
      "actor.mjs",
    ]);
    expect(launch.profile).not.toContain("(allow process-fork)");
  });

  it.each([
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:43123",
    "http://user@127.0.0.1:43123",
  ])("rejects an unauthenticated or invalid proxy URL: %s", (proxyUrl) => {
    expect(() => buildMacosSandboxArgv({ ...policy, proxyUrl }, ["/usr/bin/true"])).toThrow(
      /authenticated loopback HTTP URL/i,
    );
  });
});
