import path from "node:path";
import { pathToFileURL } from "node:url";

export async function installAuthBrokerClient(root: string): Promise<void> {
  const url = process.env.PIONEER_AUTH_BROKER_URL;
  const token = process.env.PIONEER_AUTH_BROKER_TOKEN;
  if (url === undefined || token === undefined) return;
  const module = (await import(
    pathToFileURL(path.join(root, "dist/core/auth-storage.js")).href
  )) as {
    AuthStorage: {
      prototype: {
        modify?: (
          provider: string,
          update: () => Promise<unknown>,
          options?: unknown,
        ) => Promise<unknown>;
        refreshOAuthTokenWithLock?: (provider: string) => Promise<unknown>;
        set?: (provider: string, credential: unknown) => void;
      };
    };
  };
  async function credential(provider: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9._-]+$/.test(provider))
      throw new Error("[PI_OAUTH_REFRESH_FAILED] Invalid provider");
    const response = await fetch(`${url}/oauth/${provider}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok)
      throw new Error(
        "[PI_OAUTH_REFRESH_FAILED] Refresh through Pioneer failed; verify this provider in normal Pi.",
      );
    return await response.json();
  }
  const prototype = module.AuthStorage.prototype;
  const modify = prototype.modify;
  const refresh = prototype.refreshOAuthTokenWithLock;
  if (modify !== undefined) {
    prototype.modify = async function (provider, _update, options) {
      const refreshed = await credential(provider);
      return await modify.call(this, provider, async () => refreshed, options);
    };
  } else if (refresh !== undefined && prototype.set !== undefined) {
    prototype.refreshOAuthTokenWithLock = async function (provider) {
      this.set?.(provider, await credential(provider));
      return await refresh.call(this, provider);
    };
  } else {
    throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Unsupported Pi credential contract");
  }
}
