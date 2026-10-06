export const CN_CAD_MESSAGES = {
  blankDocumentCreated: (document: string, entityCount: number) => `已在真实 AutoCAD 中新建并聚焦空白图纸 ${document}，当前实体数 ${entityCount}。`,
  playbackCompleted: '已通过 Lumi CAD MCP/COM 在真实 AutoCAD 中完成逐实体绘图并通过验收。',
  drawingOperations: '绘图操作：',
  sourceGeometryVerified: '\u539f\u56fe\u51e0\u4f55\u590d\u6838\uff1a\u901a\u8fc7\u3002',
  entityDeltaVerification: '\u5b9e\u4f53\u589e\u91cf\u9a8c\u6536\uff1a',
} as const;
