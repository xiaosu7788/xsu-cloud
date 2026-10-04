'use client';

/**
 * 评论表单。挂在帖子详情页，提交给页面传下来的 Server Action。
 *
 * ## 未登录
 *
 * 页面不读会话（详情页是 ISR），登录态由 action 服务端判定：未登录提交时 action 内部
 * `redirect()` 到登录页——那是 Next 的控制流，`useActionState` 照常接住，浏览器直接跳转。
 * 表单永远可交互，不为「猜登录态」引入一次客户端会话查询。
 *
 * ## 不设 HTML `maxLength`
 *
 * 与 `post-form.tsx` 同一条理由：领域层按码点算长度，HTML 按 UTF-16 码元算且超长粘贴静默截断。
 * 上限只作提示文字，判定留在服务端。
 */
import { useActionState } from 'react';

import { COMMENT_BODY_MAX_CHARS } from '@xsu/core';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { INITIAL_COMMENT_FORM_STATE, type CommentFormState } from './post-state';

const COMMENT_FORM_ERROR_ID = 'comment-form-error';

export function CommentForm({
  action,
}: {
  action: (state: CommentFormState, formData: FormData) => Promise<CommentFormState>;
}) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_COMMENT_FORM_STATE);
  const failure = state.status === 'error' ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {failure ? (
        <p
          id={COMMENT_FORM_ERROR_ID}
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{failure.message}</span>
          <span className="font-mono text-xs">{failure.code}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="comment-body">写下你的评论</Label>
        <Textarea
          id="comment-body"
          name="body"
          rows={4}
          aria-invalid={failure?.field === 'body' || undefined}
          aria-describedby={failure ? COMMENT_FORM_ERROR_ID : undefined}
        />
        <p className="text-xs text-muted-foreground">最多 {COMMENT_BODY_MAX_CHARS} 个字符。</p>
      </div>

      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? '正在发表…' : '发表评论'}
        </Button>
      </div>
    </form>
  );
}
