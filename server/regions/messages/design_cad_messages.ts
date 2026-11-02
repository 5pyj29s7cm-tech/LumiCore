export function designerCadVerificationFailed(locale: 'zh' | 'en'): string {
  return locale === 'zh' ? '本次 CAD 生成或工作流的最新回执未通过核验，不能用较早的成功回执声称已经完成。'
    : 'The latest CAD generation or workflow receipt is not verified. An earlier success cannot establish completion.';
}

export function formatDesignerCadFiles(files: Record<string, any>, receipt: Record<string, any>, locale: 'zh' | 'en'): string {
  return (locale === 'zh' ? ['CAD 方案已生成并核验本地 DXF 与 SVG 预览。', `DXF：${files.path}`, `SVG：${files.previewPath}`,
    `图层：${Array.isArray(files.layers) ? files.layers.join('、') : ''}`, `任务：${receipt.task.id}`, `核验：${receipt.verification.verificationId || ''}`,
    '本次 CAD 生成调用未打开外部软件；该产物回执不证明任何客户外发。文件存在和本次几何校验不替代生产尺寸复核。']
    : ['The local DXF and SVG preview were generated and verified.', `DXF: ${files.path}`, `SVG: ${files.previewPath}`,
      `Layers: ${Array.isArray(files.layers) ? files.layers.join(', ') : ''}`, `Task: ${receipt.task.id}`, `Verification: ${receipt.verification.verificationId || ''}`,
      'This CAD generation call did not open an external application. These artifact receipts do not establish customer delivery. File and geometry checks do not replace production dimension review.']).join('\n');
}
