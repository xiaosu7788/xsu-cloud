'use client';

/**
 * 发帖 / 编辑帖子的表单。控制台的两个页面（新建入口与编辑页）共用这一个组件。
 *
 * ## action 作为 prop 传入
 *
 * `useActionState` 需要的 Server Action 由页面（服务端组件）传下来，本组件不 import
 * `app/(console)/console/community/actions.ts`——import 关系一旦反向，这个客户端组件就会被
 * 绑死在控制台分区上，别处分区（哪怕只是复用 UI）都会连带拖进整套 action 依赖。
 *
 * ## 不设 HTML `maxLength`
 *
 * 与 `run-form.tsx` 同一条理由：领域层的上限按**码点**算，HTML 的 `maxlength` 按 UTF-16 码元
 * 算，emoji 上两者不一致，且浏览器对超长粘贴是静默截断。上限只作提示文字，判定留在服务端。
 */
import { useActionState } from 'react';

import { POST_BODY_MAX_CHARS, POST_TAG_MAX_COUNT, POST_TITLE_MAX_CHARS } from '@xsu/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { INITIAL_POST_FORM_STATE, type PostFormState } from './post-state';

/** 失败提示条的 id。输入控件的 `aria-describedby` 指过来，读屏才会念出失败原因。 */
const POST_FORM_ERROR_ID = 'post-form-error';

export function PostForm({
  action,
  mode,
  initial,
}: {
  /** 服务端传进来的 action（新建或编辑），形状见 `post-state.ts`。 */
  action: (state: PostFormState, formData: FormData) => Promise<PostFormState>;
  mode: 'create' | 'edit';
  /** 编辑时的现值。新建不传，控件就是空的。 */
  initial?: { title: string; body: string; tags: string };
}) {
  const [state, formAction, isPending] = useActionState(action, INITIAL_POST_FORM_STATE);
  const failure = state.status === 'error' ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {failure ? (
        <p
          id={POST_FORM_ERROR_ID}
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{failure.message}</span>
          <span className="font-mono text-xs">{failure.code}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="post-title">标题</Label>
        <Input
          id="post-title"
          name="title"
          type="text"
          defaultValue={initial?.title}
          aria-invalid={failure?.field === 'title' || undefined}
          aria-describedby={failure ? POST_FORM_ERROR_ID : undefined}
        />
        <p className="text-xs text-muted-foreground">必填。最多 {POST_TITLE_MAX_CHARS} 个字符。</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="post-body">正文</Label>
        <Textarea
          id="post-body"
          name="body"
          rows={12}
          defaultValue={initial?.body}
          aria-invalid={failure?.field === 'body' || undefined}
          aria-describedby={failure ? POST_FORM_ERROR_ID : undefined}
        />
        <p className="text-xs text-muted-foreground">必填。最多 {POST_BODY_MAX_CHARS} 个字符。</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="post-tags">标签</Label>
        <Input
          id="post-tags"
          name="tags"
          type="text"
          defaultValue={initial?.tags}
          aria-invalid={failure?.field === 'tags' || undefined}
          aria-describedby={failure ? POST_FORM_ERROR_ID : undefined}
        />
        <p className="text-xs text-muted-foreground">
          选填。用逗号或空格分隔，最多 {POST_TAG_MAX_COUNT} 个，保存时自动转小写去重。
        </p>
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? '正在保存…' : mode === 'create' ? '发布' : '保存修改'}
      </Button>
    </form>
  );
}
