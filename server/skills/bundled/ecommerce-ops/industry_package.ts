import type { WorkTakeoverIndustryPackageAdapter } from '../../../work_takeover/industry_package_adapters';
import { createEcommerceGrowthFiles } from './workflows/ecommerce_growth_workflow';

export const ecommerceOpsIndustryPackage: WorkTakeoverIndustryPackageAdapter = {
  kind: 'ecommerce_growth',
  categories: ['store', 'account', 'video_publish'],
  createFiles: createEcommerceGrowthFiles,
};
