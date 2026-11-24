import { open } from "node:fs/promises";
import path from "node:path";
import { thinkingFromModelShorthand } from "../pi-model-selection.js";
import { createEgressResolver, type EgressPolicy } from "./egress-policy.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid provider configuration");
  return value as Record<string, unknown>;
}

async function config(dir: string, name: string): Promise<Record<string, unknown>> {
  const handle = await open(path.join(dir, name), "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return {};
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid provider configuration");
    return record(JSON.parse(await handle.readFile("utf8")));
  } catch {
    throw new Error("Cannot determine provider endpoint from Pi configuration");
  } finally {
    await handle.close();
  }
}

const standardHosts = new Map([
  ["openai", "api.openai.com"],
  ["openai-codex", "chatgpt.com"],
  ["anthropic", "api.anthropic.com"],
  ["google", "generativelanguage.googleapis.com"],
  ["openrouter", "openrouter.ai"],
  ["mistral", "api.mistral.ai"],
  ["groq", "api.groq.com"],
  ["xai", "api.x.ai"],
  ["deepseek", "api.deepseek.com"],
]);

function configuredModels(entry: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(entry.models) ? entry.models.map(record) : [];
}

function selectProvider(
  requested: string | undefined,
  providers: Record<string, unknown>,
  settings: Record<string, unknown>,
) {
  if (requested === undefined) return settings.defaultProvider;
  const names = [...new Set([...Object.keys(providers), ...standardHosts.keys()])];
  const qualified = names
    .filter((name) => requested.toLowerCase().startsWith(name.toLowerCase() + "/"))
    .sort((a, b) => b.length - a.length);
  if (qualified[0]) return qualified[0];
  const owners = Object.entries(providers).filter(([, entry]) =>
    configuredModels(record(entry)).some(
      (model) => typeof model.id === "string" && model.id.toLowerCase() === requested.toLowerCase(),
    ),
  );
  return owners.length === 1 ? owners[0]?.[0] : undefined;
}

export async function resolveProviderPolicy(
  policy: EgressPolicy,
  agentDir: string,
  requested?: string,
): Promise<EgressPolicy> {
  createEgressResolver(policy);
  if (policy.network !== "provider-only") return policy;
  const settings = await config(agentDir, "settings.json");
  const models = await config(agentDir, "models.json");
  const providers = record(models.providers ?? {});
  const thinking = requested && thinkingFromModelShorthand(requested);
  const selection = thinking ? requested?.slice(0, -thinking.length - 1) : requested;
  const provider = selectProvider(selection, providers, settings);
  if (typeof provider !== "string" || !provider) {
    if (policy.allowHosts?.length) return policy;
    throw new Error(
      "Cannot determine the provider endpoint. Specify a qualified provider/model, configure a Pi defaultProvider, or pass --allow-host.",
    );
  }
  const entry = Object.hasOwn(providers, provider) ? record(providers[provider]) : {};
  const modelId = selection?.toLowerCase().startsWith(provider.toLowerCase() + "/")
    ? selection.slice(provider.length + 1)
    : (selection ?? settings.defaultModel);
  const model = configuredModels(entry).find(
    (candidate) =>
      typeof modelId === "string" &&
      typeof candidate.id === "string" &&
      candidate.id.toLowerCase() === modelId.toLowerCase(),
  );
  const endpoint = model?.baseUrl ?? entry.baseUrl;
  let host = standardHosts.get(provider);
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") throw new Error("Invalid provider endpoint");
    const url = URL.parse(endpoint);
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hostname.includes("*") ||
      !url.hostname
    )
      throw new Error("Invalid provider endpoint");
    host = url.hostname;
  }
  if (!host) {
    if (policy.allowHosts?.length) return policy;
    throw new Error(
      "Unknown provider endpoint. Configure models.json baseUrl or pass --allow-host.",
    );
  }
  return { ...policy, providerHosts: [host] };
}

export function describeEgressPolicy(policy: EgressPolicy): string {
  const rules = (list: readonly string[] | undefined) => list?.join(", ") || "none";
  return (
    "[PIONEER_NETWORK] " +
    policy.network +
    ". Provider hosts: " +
    rules(policy.providerHosts) +
    ". Allow: " +
    rules(policy.allowHosts) +
    ". Block: " +
    rules(policy.blockHosts) +
    ". Local host and metadata destinations are blocked. " +
    (policy.network === "provider-only" ? "Other web and registry lookups are blocked." : "")
  );
}
