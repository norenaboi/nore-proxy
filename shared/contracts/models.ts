export interface PublicModelPricing {
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
}

export interface PublicModelDto {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  type: string;
  pricing: PublicModelPricing | null;
}

export interface PublicModelsResponse {
  object: "list";
  data: PublicModelDto[];
}
