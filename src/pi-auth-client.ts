import path from "node:path";
import { pathToFileURL } from "node:url";

export async function installAuthBrokerClient(root: string): Promise<void> {
  const url = process.env.PIONEER_AUTH_BROKER_URL;
  const token = process.env.PIONEER_AUTH_BROKER_TOKEN;
  if (url === undefined || token === undefined) return;
  const providerNames: unknown = JSON.parse(process.env.PIONEER_AUTH_BROKER_PROVIDERS ?? "[]");
  if (!Array.isArray(providerNames) || providerNames.some((name) => typeof name !== "string"))
    throw new Error("[PI_OAUTH_REFRESH_FAILED] Invalid broker provider list");
  const providers = new Set<string>(providerNames);
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
        getOAuthProviders?: () => readonly { id: string; getApiKey(credential: unknown): string }[];
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
    prototype.modify = async function (provider, update, options) {
      if (!providers.has(provider)) return await modify.call(this, provider, update, options);
      const refreshed = await credential(provider);
      return await modify.call(this, provider, async () => refreshed, options);
    };
  } else if (
    refresh !== undefined &&
    prototype.set !== undefined &&
    prototype.getOAuthProviders !== undefined
  ) {
    const getProviders = prototype.getOAuthProviders;
    prototype.refreshOAuthTokenWithLock = async function (provider) {
      const refreshed = await credential(provider);
      const oauth = getProviders.call(this).find((candidate) => candidate.id === provider);
      if (oauth === undefined) throw new Error("[PI_OAUTH_REFRESH_FAILED] Provider is unavailable");
      this.set?.(provider, refreshed);
      return { apiKey: oauth.getApiKey(refreshed), newCredentials: refreshed };
    };
  } else {
    throw new Error("[PI_EXTENSION_RUNTIME_UNSUPPORTED] Unsupported Pi credential contract");
  }
}
