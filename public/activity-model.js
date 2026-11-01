export function countSteps(steps) {
    return {
        all: steps.length,
        success: steps.filter((step) => step.status === 'success').length,
        failure: steps.filter((step) => step.status === 'failure').length,
    };
}
export function visibleSteps(steps, filter) {
    switch (filter) {
        case 'all':
            return steps;
        case 'success':
            return steps.filter((step) => step.status === 'success');
        case 'failure':
            return steps.filter((step) => step.status === 'failure');
    }
}
export function defaultActivityFixture() {
    return [
        {
            id: 'step_000001',
            seq: 1,
            action: '导航',
            summary: '打开 https://example.test/form',
            status: 'success',
            startedAt: '13:12:01',
            durationMs: 420,
            url: 'https://example.test/form',
        },
        {
            id: 'step_000002',
            seq: 2,
            action: '获取快照',
            summary: '读取 semantic_v2 页面结构',
            status: 'success',
            startedAt: '13:12:02',
            durationMs: 180,
            url: 'https://example.test/form',
        },
        {
            id: 'step_000003',
            seq: 3,
            action: '点击',
            summary: '点击按钮 Submit',
            status: 'success',
            startedAt: '13:12:03',
            durationMs: 95,
            targetLabel: 'role=button name=Submit',
            url: 'https://example.test/form',
        },
        {
            id: 'step_000004',
            seq: 4,
            action: '输入',
            summary: '输入 Name：已脱敏',
            status: 'success',
            startedAt: '13:12:04',
            durationMs: 110,
            targetLabel: 'role=textbox name=Name',
            url: 'https://example.test/form',
        },
        {
            id: 'step_000005',
            seq: 5,
            action: '等待',
            summary: '等待结果文本 Submitted',
            status: 'success',
            startedAt: '13:12:05',
            durationMs: 240,
            url: 'https://example.test/form',
        },
        {
            id: 'step_000006',
            seq: 6,
            action: '点击',
            summary: '点击按钮 缺失按钮',
            status: 'failure',
            startedAt: '13:12:06',
            durationMs: 88,
            targetLabel: 'role=button name=缺失按钮',
            url: 'https://example.test/form',
            errorCode: 'TARGET_NOT_FOUND',
            advice: '目标元素不存在；刷新快照后重试，不要坐标兜底。',
        },
        {
            id: 'step_000007',
            seq: 7,
            action: '获取快照',
            summary: '读取失败后页面状态',
            status: 'running',
            startedAt: '13:12:07',
            durationMs: 0,
            url: 'https://example.test/form',
        },
    ];
}
export function defaultRecordingFixture() {
    return [
        {
            id: 'rec_20261030T035001Z_a1b2c3',
            title: 'Agent 浏览器表单任务',
            status: 'completed',
            stepCount: 20,
            durationMs: 18_400,
            sizeBytes: 1_204_000,
            createdAt: '2026-10-30 03:50',
        },
        {
            id: 'rec_20261030T040702Z_d4e5f6',
            title: 'Edge 表单回归',
            status: 'completed',
            stepCount: 12,
            durationMs: 9_900,
            sizeBytes: 812_000,
            createdAt: '2026-10-30 04:07',
        },
        {
            id: 'rec_20261030T041500Z_9a8b7c',
            title: '登录流程探索',
            status: 'interrupted',
            stepCount: 7,
            durationMs: 6_200,
            sizeBytes: 455_000,
            createdAt: '2026-10-30 04:15',
        },
        {
            id: 'rec_20261030T043011Z_5d6e7f',
            title: '失败页面复核',
            status: 'interrupted',
            stepCount: 3,
            durationMs: 1_800,
            sizeBytes: 188_000,
            createdAt: '2026-10-30 04:30',
        },
    ];
}
export function defaultReplayRunFixtures() {
    const failedSteps = Array.from({ length: 20 }, (_, index) => {
        const seq = index + 1;
        if (seq <= 14)
            return { id: `step_${String(seq).padStart(6, '0')}`, seq, action: seq % 4 === 0 ? '输入' : seq % 3 === 0 ? '点击' : '导航', status: 'success' };
        if (seq === 15)
            return { id: 'step_000015', seq, action: '点击', status: 'error', errorCode: 'TARGET_NOT_FOUND' };
        return { id: `step_${String(seq).padStart(6, '0')}`, seq, action: '未执行', status: 'skipped' };
    });
    const completedSteps = Array.from({ length: 20 }, (_, index) => {
        const seq = index + 1;
        return { id: `step_${String(seq).padStart(6, '0')}`, seq, action: seq % 4 === 0 ? '输入' : seq % 3 === 0 ? '点击' : '导航', status: 'success' };
    });
    return {
        failedRun: {
            id: 'run_failed_015',
            recordingId: 'rec_20261030T035001Z_a1b2c3',
            status: 'failed',
            totalSteps: 20,
            executedSteps: 15,
            failedStepId: 'step-015',
            errorCode: 'TARGET_NOT_FOUND',
            startedAt: '13:20:00',
            durationMs: 12_400,
        },
        completedRun: {
            id: 'run_completed_020',
            recordingId: 'rec_20261030T040702Z_d4e5f6',
            status: 'completed',
            totalSteps: 20,
            executedSteps: 20,
            startedAt: '13:28:00',
            durationMs: 18_900,
        },
        failedSteps,
        completedSteps,
    };
}
