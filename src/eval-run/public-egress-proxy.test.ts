import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PublicEgressProxy,
  resolvePublicTarget,
  startPublicEgressProxy,
} from "./public-egress-proxy.js";

function requestThrough(
  proxy: PublicEgressProxy,
  target: string,
  authorization?: string,
): Promise<number> {
  const proxyUrl = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: "GET",
      path: target,
      headers: authorization ? { "proxy-authorization": authorization } : undefined,
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

describe("public egress proxy", () => {
  let proxy: PublicEgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("requires its per-run authentication token", async () => {
    proxy = await startPublicEgressProxy("a".repeat(32));
    expect(await requestThrough(proxy, "http://example.com/")).toBe(407);
  });

  it("rejects authenticated requests to loopback before connecting", async () => {
    const token = "b".repeat(32);
    proxy = await startPublicEgressProxy(token);
    const authorization = `Basic ${Buffer.from(`pioneer:${token}`).toString("base64")}`;
    expect(await requestThrough(proxy, "http://127.0.0.1:9/", authorization)).toBe(403);
  });

  it.each(["localhost", "printer.lan", "10.0.0.1", "fc00::1"])(
    "rejects non-public target %s",
    async (target) => {
      await expect(resolvePublicTarget(target)).rejects.toThrow(/not allowed/i);
    },
  );
});
