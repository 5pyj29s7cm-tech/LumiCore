import type { WorkTakeoverIndustryPackageAdapter } from '../../../work_takeover/industry_package_adapters';
import { createDesignDeliveryFiles } from './workflows/design_delivery_workflow';

export const cadDraftingIndustryPackage: WorkTakeoverIndustryPackageAdapter = {
  kind: 'design_delivery',
  categories: ['design_delivery'],
  createFiles: createDesignDeliveryFiles,
};
