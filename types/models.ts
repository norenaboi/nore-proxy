import type { EndpointKey } from "./endpoint.js";

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

export interface RegisteredConcreteModel {
  type: "chat";
  routingType: "concrete";
  capabilities: ModelCapabilities;
  backend: string;
  version: EndpointKey;
  hidden: boolean;
}

export interface RegisteredAutoModel {
  type: "chat";
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
      backend: string;
      version: EndpointKey | "";
      disabled: boolean;
      hidden: boolean;
      pricing: ModelPricing;
    }
  | {
      name: string;
      modelType: "auto";
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
  type: "chat";
  pricing: Required<ModelPricing> | null;
}
