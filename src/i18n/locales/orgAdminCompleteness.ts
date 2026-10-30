const en = {
  applyRole: 'Save role', roleLabel: (id: string) => `Role for ${id}`,
  roleTitle: 'Change member role?', roleConfirm: (id: string, role: string) => `Change ${id} to ${role}? Their access will change immediately.`,
  roleSaved: 'Member role confirmed.', confirm: 'Confirm', cancel: 'Cancel',
  ownership: 'Transfer organization ownership', loadMembers: 'Load eligible members', newOwner: 'New owner', chooseMember: 'Choose an active member',
  ownershipExplanation: 'Only the current owner can transfer ownership to another active member. You will become an administrator.',
  transferConfirm: (id: string) => `Make ${id} the new owner? You will lose owner privileges and become an administrator.`,
  transferred: 'Ownership transfer confirmed.', transferUnconfirmed: 'Ownership transfer was not confirmed. Reload the organization before trying again.',
  refreshAccess: 'Refresh organization access', refreshFailed: 'Ownership changed, but session access could not be refreshed. Refresh access to continue.',
  refreshAudit: 'Refresh audit snapshot', auditCount: (shown: number, total: number) => `${shown} displayed · ${total} entries in this snapshot`,
};
const zh: typeof en = {
  applyRole: '保存角色', roleLabel: id => `${id} 的角色`,
  roleTitle: '调整成员角色？', roleConfirm: (id, role) => `将 ${id} 调整为${role}？其访问权限将立即变化。`,
  roleSaved: '成员角色已确认更新。', confirm: '确认', cancel: '取消',
  ownership: '转移组织所有权', loadMembers: '读取可转移成员', newOwner: '新所有者', chooseMember: '选择一位在职成员',
  ownershipExplanation: '仅当前所有者可以把组织转移给另一位在职成员。转移后，您将成为管理员。',
  transferConfirm: id => `将 ${id} 设为新所有者？您将失去所有者权限并成为管理员。`,
  transferred: '组织所有权已确认转移。', transferUnconfirmed: '组织所有权转移尚未确认。请重新读取组织状态后再决定是否重试。',
  refreshAccess: '刷新组织权限', refreshFailed: '所有权已转移，但会话权限刷新失败。请刷新权限后继续。',
  refreshAudit: '刷新审计快照', auditCount: (shown, total) => `当前显示 ${shown} 条 · 本次快照共 ${total} 条`,
};
export const orgAdminCompletenessCopy = (lang?: string) => lang === 'en' ? en : zh;
