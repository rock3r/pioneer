import { describe, expect, it, vi } from "vitest";
import { createEgressResolver } from "./egress-policy.js";

const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
const interfaces = () => ["192.168.2.4"];

describe("egress policy", () => {
  it("applies the hard floor even with an explicit grant in full mode", async () => {
    const resolve = createEgressResolver(
      { network: "full", allowHosts: ["0.0.0.0/0", "::/0"] },
      { lookup, interfaces },
    );
    for (const host of [
      "127.0.0.1",
      "::1",
      "169.254.169.254",
      "168.63.129.16",
      "fd00:ec2::254",
      "fe80::2",
      "64:ff9b::c000:201",
      "2002::1",
      "::ffff:7f00:1",
      "192.168.2.4",
      "metadata.google.internal.",
    ]) {
      await expect(resolve(host)).rejects.toThrow(/not allowed/i);
    }
    await expect(resolve("192.168.2.5")).resolves.toMatchObject({ address: "192.168.2.5" });
  });
  it("checks host filters before DNS, pins answers and gives block rules precedence", async () => {
    const dns = vi.fn(lookup);
    const resolve = createEgressResolver(
      {
        network: "provider-only",
        providerHosts: ["api.example.com"],
        allowHosts: ["*.mirror.test"],
        blockHosts: ["private.mirror.test", "192.168.2.0/24"],
      },
      { lookup: dns, interfaces },
    );
    for (const host of ["arbitrary.example", "private.mirror.test", "mirror.test"])
      await expect(resolve(host)).rejects.toThrow(/not allowed/i);
    expect(dns).not.toHaveBeenCalled();
    await expect(resolve("api.example.com")).resolves.toMatchObject({ address: "8.8.8.8" });
    await expect(resolve("cdn.mirror.test")).resolves.toMatchObject({ address: "8.8.8.8" });
    dns.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.2.5", family: 4 },
    ]);
    await expect(resolve("api.example.com")).rejects.toThrow(/not allowed/i);
  });
  it("fails closed on interface enumeration failure and malformed rules", async () => {
    const resolve = createEgressResolver(
      { network: "full" },
      {
        lookup,
        interfaces: () => {
          throw new Error("unavailable");
        },
      },
    );
    await expect(resolve("8.8.8.8")).rejects.toThrow();
    for (const rule of ["*", "wrong/28", "8.8.8.8/33", "https://service.test", "*.bad..host"]) {
      expect(() => createEgressResolver({ network: "public", allowHosts: [rule] })).toThrow();
    }
  });
});
