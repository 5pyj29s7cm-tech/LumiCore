export type LumiRegion = 'global' | 'cn';

export interface RegionalLegalCapability {
  externalPlatforms: readonly string[];
  authorityOrder: readonly string[];
  collaborationBoundary: string;
}

export interface RegionalCapabilityPack {
  id: LumiRegion;
  aliases: readonly string[];
  locales: readonly string[];
  capabilities: readonly string[];
  legal?: RegionalLegalCapability;
}
