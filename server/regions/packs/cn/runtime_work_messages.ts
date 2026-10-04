import type { RuntimeWorkSnapshot, RuntimeWorkPhase } from '../../../runtime/work_control';
import type { ToolExecutionRecord } from '../../../tools/types';
const labels: Record<RuntimeWorkPhase, string> = {
    queued: '排队', working: '执行中', pausing: '正在暂停', paused: '已暂停', waiting_confirmation: '等待确认',
    cancelling: '正在取消', blocked: '受阻', completed: '已完成', failed: '失败', cancelled: '已取消',
};
export function formatRuntimeWorkRead(record: ToolExecutionRecord): {
    text: string;
    blocked: boolean;
} {
    if (record.error || record.envelope?.status !== 'verified_success') {
        return { text: '暂时无法读取后台工作账本，请稍后重试。', blocked: true };
    }
    try {
        const snapshot = JSON.parse(record.result) as RuntimeWorkSnapshot;
        if (!snapshot.ok || snapshot.degraded || !Array.isArray(snapshot.items)) {
            return { text: '后台工作账本有数据源暂时不可用，当前状态尚不能完整确认。', blocked: true };
        }
        const active = snapshot.items.filter(item => !['completed', 'cancelled'].includes(item.phase));
        const items = (active.length ? active : snapshot.items).slice(0, 8);
        return { blocked: false, text: [
                '后台工作账本：执行或排队 ' + snapshot.activeCount + ' 项，暂停 ' + snapshot.pausedCount + ' 项，受阻或失败 ' + snapshot.blockedCount + ' 项。',
                ...items.map(item => '- ' + item.title + '：' + labels[item.phase] + (item.blocker ? '；' + item.blocker : '')),
            ].join('\n') };
    }
    catch {
        return { text: '后台工作账本未返回可核验的状态，请稍后重试。', blocked: true };
    }
}
