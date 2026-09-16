import { apiFormatSpec, type ImageApiFormat } from "../shared/contracts/apiFormats.js";
import type { ModelRegistry, RegisteredModel } from "../types/models.js";

/** Only expose settings shared by every resolvable target of an automatic model. */
export function imageModelFormat(
  model: RegisteredModel,
  registry: ModelRegistry,
  endpoints: Record<string, { apiFormat?: string }>,
): ImageApiFormat | undefined {
  if (model.modality !== "image") return undefined;
  const targets = model.routingType === "concrete" ? [model] : model.targets
    .map((name) => registry[name])
    .filter((target) => target?.routingType === "concrete");
  const formats = targets.map((target) => target.routingType === "concrete"
    ? apiFormatSpec(endpoints[target.version]?.apiFormat)
    : null);
  if (!formats.length || formats.some((format) => format?.category !== "image")) return undefined;
  const first = formats[0]!.value as ImageApiFormat;
  const gemini = first === "gemini-interactions";
  return formats.every((format) => (format!.value === "gemini-interactions") === gemini) ? first : undefined;
}
