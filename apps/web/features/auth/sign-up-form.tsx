'use client';

/**
 * 注册表单。
 *
 * ## 为什么走 Server Action 而不是客户端直连
 *
 * 注册要过邀请码准入，判定与「建号 → 消费 → 失败回滚」都在领域层，浏览器不该直接调
 * Better Auth 的端点——库自己的 `/sign-up/email` 已经被关掉了（见 `./client`）。
 * `useActionState` + `<form action>` 另外给了一件事：**没有 JavaScript 时表单仍然能提交**，
 * 失败原因由服务端算出来，客户端只负责显示，不需要维护一份并行的校验规则。
 *
 * ## 空值在本地挡掉
 *
 * 与 `sign-in-form.tsx` 同一条约定：字段为空是「用户还没填完」，不必往返一次服务端；
 * 服务端的文案留给「填了但填错」。两者渲染在同一个提示条里，用户只看到一处。
 *
 * ## 成功之后不跳转
 *
 * 注册成功不签发会话（`requireEmailVerification` 已打开），用户要先完成邮箱验证。
 * 跳转控制台只会立刻被守卫退回登录页，看起来像注册失败。这里原地显示「去查邮件」，
 * 并给出去登录页的出口。
 *
 * ## 口令下限只写一次
 *
 * `PASSWORD_MIN_LENGTH` 从 `@xsu/core` 取，不在本文件写 8：提示文案、`minLength` 与服务端
 * 真实校验必须是同一个数字，写在两处必然出现「提示说 8 位、服务端按别的数字拒」。
 * 这个数字的使用点清单写在 `packages/core/src/registration.ts`。
 */
import { PASSWORD_MIN_LENGTH } from '@xsu/core';
import Link from 'next/link';
import { useActionState, useState, type FormEvent } from 'react';

import { signUpWithInvite } from '@/app/(site)/sign-up/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { SIGN_IN_PATH } from './routes';
import { INITIAL_SIGN_UP_STATE, readField } from './sign-up';

/** 表单字段名。与 `<Input name>` 的取值必须一致，写错不会有编译错误，只有白填一次表单。 */
type FieldName = 'name' | 'email' | 'password' | 'inviteCode';

const NO_BLANK_FIELDS: Record<FieldName, boolean> = {
  name: false,
  email: false,
  password: false,
  inviteCode: false,
};

const EMPTY_FIELD_MESSAGE = '请填写昵称、邮箱、密码与邀请码。';

export function SignUpForm() {
  const [state, formAction, isPending] = useActionState(signUpWithInvite, INITIAL_SIGN_UP_STATE);
  const [blankFields, setBlankFields] = useState(NO_BLANK_FIELDS);
  const [localError, setLocalError] = useState<string | null>(null);

  /** 本地判定优先：提交时先清掉服务端上一次的残留，用户改完就是干净的一次尝试。 */
  const error = localError ?? (state.status === 'error' ? state.message : null);
  const describedBy = error ? 'sign-up-error' : undefined;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const blank: Record<FieldName, boolean> = {
      name: readField(data, 'name').trim() === '',
      email: readField(data, 'email').trim() === '',
      // 口令只看是不是空串，不 trim：前后空格是合法口令的一部分，裁掉会得到「我设的密码登不上」。
      password: readField(data, 'password') === '',
      inviteCode: readField(data, 'inviteCode').trim() === '',
    };

    setBlankFields(blank);
    if (Object.values(blank).some(Boolean)) {
      event.preventDefault();
      setLocalError(EMPTY_FIELD_MESSAGE);
      return;
    }
    setLocalError(null);
  }

  if (state.status === 'created') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>账号已创建</CardTitle>
          <CardDescription>还差一步：完成邮箱验证。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            验证邮件已经发出。点开邮件里的链接完成验证后，就可以用邮箱密码登录。
          </p>
          <Button asChild variant="outline">
            <Link href={SIGN_IN_PATH}>去登录</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>注册</CardTitle>
        <CardDescription>本站不开放自由注册，注册需要邀请码。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error ? (
          <p
            id="sign-up-error"
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <form
          onSubmit={handleSubmit}
          action={formAction}
          noValidate
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-up-name">昵称</Label>
            <Input
              id="sign-up-name"
              name="name"
              type="text"
              autoComplete="nickname"
              aria-invalid={blankFields.name || undefined}
              aria-describedby={describedBy}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-up-email">邮箱</Label>
            <Input
              id="sign-up-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              aria-invalid={blankFields.email || undefined}
              aria-describedby={describedBy}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-up-password">密码</Label>
            <Input
              id="sign-up-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              aria-invalid={blankFields.password || undefined}
              aria-describedby={describedBy}
            />
            <p className="text-xs text-muted-foreground">至少 {PASSWORD_MIN_LENGTH} 位。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-up-invite">邀请码</Label>
            <Input
              id="sign-up-invite"
              name="inviteCode"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={blankFields.inviteCode || undefined}
              aria-describedby={describedBy}
            />
            <p className="text-xs text-muted-foreground">
              一次性，区分大小写。从聊天窗口复制时注意别带上空格。
            </p>
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? '正在创建账号…' : '注册'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
