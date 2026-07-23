import type { PiConfiguredModel } from "./pi-model-selection.js";

export interface ModelCatalogEntry {
  readonly provider: string;
  readonly id: string;
  readonly qualifiedName: string;
}

export interface ModelCatalogJson {
  readonly schemaVersion: 1;
  readonly piVersion: string;
  readonly models: readonly ModelCatalogEntry[];
}

function catalogEntries(models: readonly PiConfiguredModel[]): ModelCatalogEntry[] {
  return models
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      qualifiedName: `${model.provider}/${model.id}`,
    }))
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
}

export function formatModelCatalog(models: readonly PiConfiguredModel[]): string {
  return `${catalogEntries(models)
    .map((model) => model.qualifiedName)
    .join("\n")}\n`;
}

export function modelCatalogJson(
  piVersion: string,
  models: readonly PiConfiguredModel[],
): ModelCatalogJson {
  return {
    schemaVersion: 1,
    piVersion,
    models: catalogEntries(models),
  };
}
