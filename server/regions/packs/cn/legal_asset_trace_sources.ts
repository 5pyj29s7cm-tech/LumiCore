// CN tender-source presentation reused by the shared legal source owner.
export const CN_ASSET_TRACE_SOURCE_COPY = {
  tenderData: {
    label: '招投标数据网关',
    configuredBoundary: '已配置律所采购或自建的招投标数据网关；只能按授权字段、地区、期限和调用额度查询。',
    unconfiguredBoundary: '尚未填写招投标数据端点和凭证；不会把全国公共资源交易平台网页误称为开放 API。',
    configuredNextAction: '可调用 legal_search_tender_projects 查询项目、中标方、采购方、金额和公告链接。',
    unconfiguredNextAction: '取得数据服务合同及接口文档后填写 TENDER_DATA_API_KEY、TENDER_DATA_BASE_URL；当前使用全国公共资源交易平台官网核验。',
    apiSourceName: '招投标授权数据网关',
  },
} as const;
