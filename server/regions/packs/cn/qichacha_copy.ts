// Chinese legal-source display text; transport decisions remain in server/legal/sources.ts.
export const CN_QICHACHA_QUERY_COPY = {
  mcpSourceName: '企查查官方 MCP',
  mcpBoundary: '已配置企查查官方 MCP 密钥，可按授权范围查询；配置成功不代表本次查询成功。',
  unconfiguredNextAction: 'MCP 接入填写 QICHACHA_API_KEY；旧开放平台填写 QICHACHA_APP_KEY 与 QICHACHA_SECRET_KEY。',
  failurePrefix: '企查查查询未完成',
  failureMessages: {
    authorization: '授权未通过，请检查企查查 MCP 密钥和接口权限。',
    timeout: '查询超时，尚未取得结果。',
    connection: '连接未完成，请检查网络、代理和接口可达性。',
    response: '返回内容无法解析或缺少所查询的企业字段。',
    provider: '服务端拒绝本次查询，请检查接口权限、额度和查询条件。',
    empty: '本次响应没有可核验记录；不能据此认定企业或相关记录不存在。',
  },
} as const;
