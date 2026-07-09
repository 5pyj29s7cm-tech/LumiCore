import { describe, expect, it } from 'vitest';
import { isDesignDeliveryRequest } from '../server/skills/bundled/cad-drafting/workflows/design_delivery_workflow';

describe('CAD real-folder routing', () => {
  it('does not route local AutoCAD drawing work into the design-delivery demo workflow', () => {
    const realFolderTask =
      '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u5148\u8bfb\u53d6\u5e76\u6574\u7406\u91cc\u9762\u7684\u6587\u4ef6\u5185\u5bb9\uff0c\u7136\u540e\u6839\u636e\u91cc\u9762\u7684\u4fe1\u606f\u751f\u6210 CAD \u56fe\u7eb8\u65b9\u6848\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765';

    expect(isDesignDeliveryRequest(realFolderTask)).toBe(false);
  });

  it('still allows explicit design-delivery package requests to use the workflow', () => {
    const deliveryTask =
      'Lumi\uff0c\u5f00\u59cb\u88c5\u4fee\u8bbe\u8ba1\u4ea4\u4ed8\uff0c\u751f\u6210\u5ba2\u6237\u6c47\u62a5 PPT/PDF\u3001\u9884\u7b97\u3001CAD DXF \u548c Revit/Dynamo \u4ea4\u63a5\u5305';

    expect(isDesignDeliveryRequest(deliveryTask)).toBe(true);
  });
});
