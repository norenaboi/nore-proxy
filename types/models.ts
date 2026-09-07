import type { EndpointKey } from "./endpoint.js";
import type { ModelModality } from "../shared/contracts/models.js";

export type { ModelModality };

export type ModelType = "concrete" | "auto";
export type TargetSelection = "sticky" | "roundrobin";

export interface ModelPricing {
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
}

interface StoredModelBase {
  type?: ModelType;
  pricing?: ModelPricing;
  disabled?: boolean;
  hidden?: boolean;
  /**
   * No `modality` field: it is derived from the API format of the serving
   * endpoint, and for automatic models from the targets. Files written when the
   * field was editable may still carry it; the loader warns and ignores it. It
   * remains reachable through the index signature below.
   */
  [key: string]: unknown;
}

export interface ConcreteModel extends StoredModelBase {
  type?: "concrete";
  backend?: string;
  version: EndpointKey;
}

export interface AutoModel extends StoredModelBase {
  type: "auto";
  targets: string[];
  targetSelection?: TargetSelection;
  maxTargetAttempts?: number | null;
}

export type ModelDefinition = ConcreteModel | AutoModel;

export interface ModelsDocument {
  models: Record<string, ModelDefinition>;
}

export interface ModelCapabilities {
  outputCapabilities: Record<string, unknown>;
}

/**
 * The `type` a registered model reports to clients, naming the route that
 * serves it: "chat" for text models, "image" for POST /v1/images, and
 * "embedding" for POST /v1/embeddings.
 */
export type RegisteredModelType = "chat" | "image" | "embedding";

export interface RegisteredConcreteModel {
  type: RegisteredModelType;
  modality: ModelModality;
  routingType: "concrete";
  capabilities: ModelCapabilities;
  backend: string;
  version: EndpointKey;
  hidden: boolean;
}

export interface RegisteredAutoModel {
  type: RegisteredModelType;
  modality: ModelModality;
  routingType: "auto";
  capabilities: ModelCapabilities;
  targets: string[];
  targetSelection: TargetSelection;
  maxTargetAttempts: number | null;
  hidden: boolean;
}

export type RegisteredModel = RegisteredConcreteModel | RegisteredAutoModel;
export type ModelRegistry = Record<string, RegisteredModel>;
export type ModelAliases = Record<string, string>;
export type ModelPricingRegistry = Record<string, Required<ModelPricing>>;

/** Normalized admin API representation of either model category. */
export type AdminModelRecord =
  | {
      name: string;
      modelType: "concrete";
      modality: ModelModality;
      backend: string;
      version: EndpointKey | "";
      disabled: boolean;
      hidden: boolean;
      pricing: ModelPricing;
    }
  | {
      name: string;
      modelType: "auto";
      modality: ModelModality;
      targets: string[];
      targetSelection: TargetSelection;
      maxTargetAttempts: number | null;
      disabled: boolean;
      hidden: boolean;
      pricing: ModelPricing;
    };

export interface PublicModel {
  id: string;
  object: "model";
  created: number;
  owned_by: "nore-proxy";
  type: RegisteredModelType;
  modality: ModelModality;
  pricing: Required<ModelPricing> | null;
}
