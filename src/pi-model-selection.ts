import { isThinkingLevel, type ThinkingLevel } from "./thinking-level.js";

export interface PiConfiguredModel {
  readonly provider: string;
  readonly id: string;
}

export type PiModelResolution =
  | { readonly ok: true; readonly qualifiedName: string }
  | { readonly ok: false; readonly error: string };

export function configuredModelNames(models: readonly PiConfiguredModel[]): string[] {
  return models
    .map((model) => `${model.provider}/${model.id}`)
    .sort((left, right) => left.localeCompare(right));
}

function withoutThinkingShorthand(requestedModel: string): string {
  const separator = requestedModel.lastIndexOf(":");
  if (separator < 0) return requestedModel;
  const thinkingLevel = requestedModel.slice(separator + 1);
  return isThinkingLevel(thinkingLevel) ? requestedModel.slice(0, separator) : requestedModel;
}

export function thinkingFromModelShorthand(requestedModel: string): ThinkingLevel | undefined {
  const separator = requestedModel.lastIndexOf(":");
  if (separator < 0) return undefined;
  const value = requestedModel.slice(separator + 1);
  return isThinkingLevel(value) ? value : undefined;
}

function catalogText(models: readonly PiConfiguredModel[]): string {
  return `Configured Pi models:\n${configuredModelNames(models)
    .map((name) => `- ${name}`)
    .join("\n")}`;
}

export function resolvePiModel(
  requestedModel: string,
  models: readonly PiConfiguredModel[],
): PiModelResolution {
  const requested = withoutThinkingShorthand(requestedModel.trim());
  const normalized = requested.toLowerCase();
  const qualified = requested.includes("/");
  const matches = models.filter((model) => {
    const candidate = qualified ? `${model.provider}/${model.id}` : model.id;
    return candidate.toLowerCase() === normalized;
  });

  if (matches.length === 1) {
    const [match] = matches;
    if (match === undefined) throw new Error("Pi model resolution invariant failed");
    return { ok: true, qualifiedName: `${match.provider}/${match.id}` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: [
        `Requested Pi model "${requestedModel}" is ambiguous. Use a qualified provider/model name.`,
        catalogText(models),
      ].join("\n"),
    };
  }
  return {
    ok: false,
    error: [`Requested Pi model "${requestedModel}" is not configured.`, catalogText(models)].join(
      "\n",
    ),
  };
}
