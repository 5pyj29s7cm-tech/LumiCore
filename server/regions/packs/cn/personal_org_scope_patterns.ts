export function matchesCnOrganizationScopeRequest(text: string): boolean {
  return /(?:进入|切换到|切到|转到|使用|退出|离开|返回|切回|回到).{0,24}(?:组织|工作域|组织工作台)/.test(text)
    || /(?:组织|公司|团队|律所)(?:里|内|的)?(?:知识库|资料库|文档库|文件|案件|案号|卷宗|材料|成员|权限|工作台|Lumi)/i.test(text)
    || /(?:工作域|组织工作台|组织知识|组织资料|组织文档|组织案件|组织卷宗|律所工作台)/.test(text)
    || /(?:归档|入案|导入|保存到|存入).{0,24}(?:案件|案号|卷宗|组织知识库|组织资料库)/.test(text)
    || /(?:提取|调取|获取|查看|整理|总结|摘要|列出).{0,40}(?:组织案件|组织案号|组织卷宗|组织资料|组织文档|组织知识)/.test(text);
}

export function matchesCnOrganizationContinuationRequest(text: string): boolean {
  return /^(?:继续|接着|下一步|然后|确认|确认执行|继续执行|重试|再试一次|按这个|照这个|就这样|往下做)/.test(text)
    || /^(?:刚刚|刚才|前面).{0,48}(?:不是指令|那句话|那条消息|那个任务|案件|材料|文件|结果|步骤)/.test(text)
    || /^(?:你)?(?:重新)?理解一下(?:刚刚|刚才|那句|那条)/.test(text);
}
