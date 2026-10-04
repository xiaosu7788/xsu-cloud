/**
 * 举报提交接口：`POST /api/community/reports`。
 *
 * 举报**不改动任何内容状态**（PRD 3.2 验收 4：不自动下架，必须有管理员确认路径）——
 * 这条规则在 `@xsu/core` 的 `src/community/reports.ts`，本层只把请求体摊成一次调用。
 * 重复举报的幂等（返回既有那条）也由领域层负责，调用方拿到 `alreadyReported` 自行提示。
 */
import { NextResponse } from 'next/server';

import { createReport } from '@xsu/core';
import { createCommunityPorts } from '@xsu/platform';

import { readSessionUser } from '@/features/auth/session';

export async function POST(request: Request): Promise<Response> {
  const user = await readSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: '登录之后才能举报。' } },
      { status: 401 },
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const outcome = await createReport(await createCommunityPorts({ userId: user.id }), {
    reporterId: user.id,
    targetType: (payload as { targetType?: unknown } | null)?.targetType,
    targetId: (payload as { targetId?: unknown } | null)?.targetId,
    reason: (payload as { reason?: unknown } | null)?.reason,
  });
  if (!outcome.ok) {
    const { status, code, message } = outcome.failure;
    return NextResponse.json({ error: { code, message } }, { status });
  }

  return NextResponse.json(
    { reportId: outcome.reportId, alreadyReported: outcome.alreadyReported },
    { status: 201 },
  );
}
