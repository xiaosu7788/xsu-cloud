'use client';

/**
 * 举报按钮：把帖子 / 评论提交给举报接口。
 *
 * ## 为什么走 fetch 而不是表单
 *
 * 举报是「附言式」轻操作：按钮旁边没有理由输入框（理由来自一个可折叠的小输入区，见下），
 * 展开与否是纯客户端状态；提交结果也不跳页——「已有人举报过」和「举报成功」都要原地变成
 * 一句话（`ReportOutcome.alreadyReported` 由接口给出，spec 第 4.4 节）。表单 + Server Action
 * 做不到不打断阅读地原地反馈。
 *
 * ## 未登录
 *
 * 与 `like-button.tsx` 同一条策略：公开页不读会话，未登录点击时接口返回 401 JSON，这里显示
 * 接口给的一句话，不跳登录页——举报人不必为了举报先登录再找回来路。
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { API_COMMUNITY_REPORTS } from '@/features/community/routes';

export function ReportButton({
  targetType,
  targetId,
}: {
  targetType: 'post' | 'comment';
  targetId: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function submit(reason: string) {
    setStatus('submitting');
    setMessage(null);
    try {
      const response = await fetch(API_COMMUNITY_REPORTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, reason }),
      });
      const data: unknown = await response.json().catch(() => null);
      const apiMessage =
        typeof data === 'object' &&
        data !== null &&
        typeof (data as { message?: unknown }).message === 'string'
          ? (data as { message: string }).message
          : null;

      if (!response.ok) {
        setMessage(apiMessage ?? '举报失败，请重试。');
        setStatus('idle');
        return;
      }

      /*
       * `alreadyReported` 为真也是成功路径：既有的未处理举报还在走流程，不重复落行。
       * 两种情况对用户的差别只在这句话里，界面状态是同一个「已提交」。
       */
      const alreadyReported =
        typeof data === 'object' &&
        data !== null &&
        (data as { alreadyReported?: unknown }).alreadyReported === true;
      setMessage(
        alreadyReported
          ? (apiMessage ?? '这条内容已经有人举报过了，我们会尽快处理。')
          : (apiMessage ?? '举报已提交，感谢你的反馈。'),
      );
      setStatus('done');
      setOpen(false);
    } catch {
      setMessage('网络异常，请重试。');
      setStatus('idle');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {status !== 'done' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          {open ? '收起' : '举报'}
        </Button>
      ) : null}

      {open && status !== 'done' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const reason = new FormData(event.currentTarget).get('reason');
            if (typeof reason === 'string' && reason.trim() !== '') {
              void submit(reason);
            }
          }}
          className="flex flex-col gap-2 rounded-md border border-border px-3 py-3"
        >
          <Label htmlFor="report-reason">举报理由</Label>
          <Textarea
            id="report-reason"
            name="reason"
            rows={3}
            placeholder="说明这条内容为什么违规。"
            required
          />
          <div>
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={status === 'submitting'}
            >
              {status === 'submitting' ? '正在提交…' : '提交举报'}
            </Button>
          </div>
        </form>
      ) : null}

      {message ? (
        <p role={status === 'done' ? 'status' : 'alert'} className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
