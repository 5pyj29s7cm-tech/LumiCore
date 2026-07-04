import { cadDraftingIndustryPackage } from '../skills/bundled/cad-drafting/industry_package';
import { ecommerceOpsIndustryPackage } from '../skills/bundled/ecommerce-ops/industry_package';

export type WorkTakeoverIndustryPackageKind = 'ecommerce_growth' | 'design_delivery';

export interface WorkTakeoverIndustryPackageAdapter {
  kind: WorkTakeoverIndustryPackageKind;
  categories: string[];
  createFiles: (source: string, options?: { outputDirectory?: string }) => any;
}

const INDUSTRY_PACKAGE_ADAPTERS: WorkTakeoverIndustryPackageAdapter[] = [
  cadDraftingIndustryPackage,
  ecommerceOpsIndustryPackage,
];

export function listIndustryPackageAdapters(): WorkTakeoverIndustryPackageAdapter[] {
  return [...INDUSTRY_PACKAGE_ADAPTERS];
}

export function getIndustryPackageAdapter(kind: WorkTakeoverIndustryPackageKind): WorkTakeoverIndustryPackageAdapter {
  const adapter = INDUSTRY_PACKAGE_ADAPTERS.find(item => item.kind === kind);
  if (!adapter) throw new Error(`No industry package adapter is registered for "${kind}".`);
  return adapter;
}

export function isEcommerceGrowthCategory(category: string): boolean {
  return getIndustryPackageAdapter('ecommerce_growth').categories.includes(category);
}

export function packageKindForCategory(category: string): WorkTakeoverIndustryPackageKind | null {
  const normalized = String(category || '');
  return INDUSTRY_PACKAGE_ADAPTERS.find(adapter => adapter.categories.includes(normalized))?.kind || null;
}
