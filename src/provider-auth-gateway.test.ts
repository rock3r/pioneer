import http from "node:http";
import https from "node:https";
import { expect, it, vi } from "vitest";
import { startProviderAuthGateway } from "./provider-auth-gateway.js";

// Public loopback test credentials for configured.invalid, valid from 2020 through 2098.
const FIXTURE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJDzB43CFaQhLLjzHN4ri8YLUW7RqbUCfFzz4cyrLaK7oAoGCCqGSM49
AwEHoUQDQgAE8JRb7kljVQRnKemWR9C9OQGbglZHTwqpn+7uRlOsvVmihDnaLKSb
wz1xU55kptBoQ2Q3J9J+ilADGQQ5UNRp8A==
-----END EC PRIVATE KEY-----`;

const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBgjCCASigAwIBAgIBATAKBggqhkjOPQQDAjAdMRswGQYDVQQDDBJjb25maWd1
cmVkLmludmFsaWQwIBcNMjAwMTAxMDAwMDAwWhgPMjA5OTAxMDEwMDAwMDBaMB0x
GzAZBgNVBAMMEmNvbmZpZ3VyZWQuaW52YWxpZDBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABPCUW+5JY1UEZynplkfQvTkBm4JWR08KqZ/u7kZTrL1ZooQ52iykm8M9
cVOeZKbQaENkNyfSfopQAxkEOVDUafCjVzBVMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgKEMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdEQQWMBSCEmNv
bmZpZ3VyZWQuaW52YWxpZDAKBggqhkjOPQQDAgNIADBFAiEAsoC5aF3CBWCuOrrz
LsakPp74lvcxjCimt2UOpXX02wsCIEv6NRrgK3iR2qXMjJdqr/YBlHcD2Vn7dmJm
fmjQJUg2
-----END CERTIFICATE-----`;

it("limits credential injection to the configured model route and strips reflected secrets and redirects", async () => {
  const secret = "mock-oauth-access-token";
  const received = vi.fn();
  let redirect = false;
  const fakeProvider = http.createServer((request, response) => {
    received(request.headers);
    request.resume();
    if (redirect) {
      response.writeHead(302, { location: "https://other.invalid/path" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": `secret=${secret}`,
    });
    response.write(`data: ${secret.slice(0, 8)}`);
    setImmediate(() => response.end(`${secret.slice(8)}\n\n`));
  });
  await new Promise<void>((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
  const address = fakeProvider.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not bind test provider");
  const resolve = vi.fn(async () => ({ address: "93.184.216.34", family: 4 as const }));
  const send = vi.fn(
    (options: https.RequestOptions, listener: (response: http.IncomingMessage) => void) =>
      http.request({ ...options, host: "127.0.0.1", port: address.port }, listener),
  );
  const gateway = await startProviderAuthGateway(
    {
      upstream: new URL("https://configured.invalid/v1"),
      suffix: "/chat/completions",
      optionalQuery: "beta=true",
      model: "selected-model",
      actorHeader: "x-api-key",
      upstreamHeader: "authorization",
      credential: async () => secret,
    },
    resolve,
    send,
  );

  try {
    const endpoint = `${gateway.baseUrl}/chat/completions`;
    const call = async (
      url = endpoint,
      extraHeaders: Record<string, string> = {},
      model = "selected-model",
    ) =>
      await fetch(url, {
        method: "POST",
        headers: { "x-api-key": gateway.placeholder, ...extraHeaders },
        body: JSON.stringify({ model }),
      });
    expect((await call(`${gateway.baseUrl}/unrelated`)).status).toBe(404);
    expect((await call(`${endpoint}?beta=true&extra=true`)).status).toBe(404);
    expect((await call(endpoint, { "x-api-key": "fake-invalid-key" })).status).toBe(401);
    expect((await call(endpoint, { "x-reflect-credential": gateway.placeholder })).status).toBe(
      401,
    );
    expect((await call(endpoint, {}, "other-model")).status).toBe(400);
    expect(received).not.toHaveBeenCalled();

    const response = await call(endpoint, { "x-other": "actor-provided" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("data: [REDACTED]\n\n");
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: `Bearer ${secret}` }),
    );
    expect(received.mock.calls[0]?.[0]).not.toHaveProperty("x-api-key");
    expect(received.mock.calls[0]?.[0]).not.toHaveProperty("x-other");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("configured.invalid", 443);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "93.184.216.34",
        servername: "configured.invalid",
        path: "/v1/chat/completions",
      }),
      expect.any(Function),
    );
    const beta = await call(`${endpoint}?beta=true`);
    expect(beta.status).toBe(200);
    expect(await beta.text()).toBe("data: [REDACTED]\n\n");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/v1/chat/completions?beta=true" }),
      expect.any(Function),
    );

    redirect = true;
    const redirected = await call();
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    await gateway.close();
    fakeProvider.closeAllConnections();
    await new Promise<void>((done) => fakeProvider.close(() => done()));
  }
});

it("delivers the upstream credential only over TLS trusted for the configured hostname", async () => {
  const secret = "mock-tls-provider-token";
  const received = vi.fn();
  const server = https.createServer(
    { key: FIXTURE_KEY, cert: FIXTURE_CERT },
    (request, response) => {
      received(request.headers.host, request.headers.authorization, request.url);
      request.resume();
      response.end('{"result":"ok"}');
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TLS fixture did not bind");
    for (const { hostname, ca, expectedStatus } of [
      { hostname: "configured.invalid", ca: [], expectedStatus: 502 },
      { hostname: "other.invalid", ca: FIXTURE_CERT, expectedStatus: 502 },
      { hostname: "configured.invalid", ca: FIXTURE_CERT, expectedStatus: 200 },
    ]) {
      const send = vi.fn(
        (options: https.RequestOptions, listener: (response: http.IncomingMessage) => void) =>
          https.request({ ...options, port: address.port, ca }, listener),
      );
      const gateway = await startProviderAuthGateway(
        {
          upstream: new URL(`https://${hostname}/v1`),
          suffix: "/responses",
          model: "fixture-model",
          actorHeader: "authorization",
          upstreamHeader: "authorization",
          credential: async () => secret,
        },
        async () => ({ address: "127.0.0.1", family: 4 }),
        send,
      );
      try {
        const response = await fetch(`${gateway.baseUrl}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${gateway.placeholder}` },
          body: JSON.stringify({ model: "fixture-model" }),
        });
        expect(response.status, hostname).toBe(expectedStatus);
        const body: unknown = await response.json();
        if (expectedStatus === 200) expect(body).toEqual({ result: "ok" });
        else expect(received).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            host: "127.0.0.1",
            port: 443,
            servername: hostname,
            rejectUnauthorized: true,
          }),
          expect.any(Function),
        );
      } finally {
        await gateway.close();
      }
    }
    expect(received).toHaveBeenCalledExactlyOnceWith(
      "configured.invalid",
      `Bearer ${secret}`,
      "/v1/responses",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
