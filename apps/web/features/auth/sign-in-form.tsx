'use client';

/**
 * 登录表单。
 *
 * ## 邮箱密码是主路径
 *
 * `docs/ROADMAP.md` M1 把邮箱密码定为账号体系的主路径，所以它排在前面并且是默认焦点。
 * 第三方登录按环境变量决定渲染几个：一个都没配的部署（例如刚克隆下来还没申请 OAuth 应用）
 * 不应该显示两个点了必然报错的按钮——提供方清单由服务端读配置后传进来，见
 * `app/(site)/sign-in/page.tsx`。
 *
 * ## 为什么不用 `required` 和原生校验气泡
 *
 * `components/ui/input.tsx` 的文件头定下「错误统一由组件渲染」，用 `aria-invalid` 表达字段
 * 状态。原生校验气泡与我们的错误文案会同时出现，而且气泡的样式不可控、位置在移动端常常
 * 被键盘挡住。因此表单加 `noValidate`，校验在提交处理里做，错误通过 `aria-describedby`
 * 指到同一段文案上——屏幕阅读器读的是同一句话，不依赖气泡。
 *
 * ## 错误文案为什么按错误码映射
 *
 * Better Auth 的报错原文是英文（`Invalid email or password`），直接显示给中文用户不合适；
 * 而显示一句无差别的「登录失败」会把「密码错了」和「邮箱没验证」混成一件事，后者用户
 * 无论怎么重试密码都不会成功。`INVALID_EMAIL_OR_PASSWORD` 与 `EMAIL_NOT_VERIFIED` 两个码
 * 来自 `@better-auth/core` 的 `dist/error/codes.mjs`，是 Service 端真实返回的取值。
 */
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { signIn } from './client';
import type { SignInProvider } from './oauth';
import { CONSOLE_HOME, SIGN_IN_PATH } from './routes';

/** 邮箱密码登录的已知失败码到中文文案。 */
const EMAIL_ERROR_MESSAGE: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
  EMAIL_NOT_VERIFIED: '邮箱尚未验证。请先完成邮箱验证，再回来登录。',
};

const EMAIL_ERROR_FALLBACK = '登录失败，请稍后重试。';
const OAUTH_ERROR_FALLBACK = '第三方登录失败，请稍后重试。';
const NETWORK_ERROR_MESSAGE = '登录失败，请检查网络后重试。';
const EMPTY_FIELD_MESSAGE = '请填写邮箱与密码。';

/**
 * 取出错误对象上的 `code`。
 *
 * 不写成 `(error as { code: string }).code`：这个字段由 `@better-fetch/fetch` 在构造错误时
 * 从响应体合并上来，运行时未必存在（网络层错误就没有）。取不到就交回 `null`，由调用方
 * 落到通用文案，而不是让一个 `undefined` 在类型上冒充字符串。
 */
function readFailureCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

export function SignInForm({
  providers,
  callbackError,
}: {
  providers: readonly SignInProvider[];
  /** 第三方登录失败后由 URL 带回来的文案（见 `./oauth`），可能为空。 */
  callbackError?: string | null;
}) {
  const router = useRouter();
  /** 正在进行的动作：`'email'` 或某个提供方 id。用来禁用全部按钮，避免重复提交。 */
  const [pending, setPending] = useState<'email' | string | null>(null);
  const [error, setError] = useState<string | null>(callbackError ?? null);
  const [invalidFields, setInvalidFields] = useState({ email: false, password: false });

  async function handleEmailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);
    const readField = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const email = readField('email').trim();
    const password = readField('password');

    const invalid = { email: email === '', password: password === '' };
    setInvalidFields(invalid);
    if (invalid.email || invalid.password) {
      setError(EMPTY_FIELD_MESSAGE);
      return;
    }

    setPending('email');
    setError(null);
    try {
      const { error: failure } = await signIn.email({ email, password });
      if (failure) {
        setError(EMAIL_ERROR_MESSAGE[readFailureCode(failure) ?? ''] ?? EMAIL_ERROR_FALLBACK);
        return;
      }
      /*
       * 用 `replace` 而不是 `push`：登录页不该留在历史里，否则用户在控制台按返回会看到
       * 一个「已经登录了还能再点一次登录」的页面。目标页是动态渲染的，跳转本身就带回了
       * 新的外壳，不需要再 `refresh()`。
       */
      router.replace(CONSOLE_HOME);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setPending(null);
    }
  }

  async function handleProviderSignIn(provider: SignInProvider) {
    setPending(provider.id);
    setError(null);
    try {
      const { error: failure } = await signIn.social({
        provider: provider.id,
        callbackURL: CONSOLE_HOME,
        // 失败时 Better Auth 把 `?error=<code>` 附在这个地址上重定向，指回本页才能显示出来。
        errorCallbackURL: SIGN_IN_PATH,
      });
      if (failure) {
        setError(OAUTH_ERROR_FALLBACK);
        return;
      }
      /*
       * 成功时客户端插件已经把浏览器导航到提供方（`window.location.href = url`），
       * 因此这里**不**清除 pending：清掉会让按钮在页面卸载前闪回可点状态，
       * 用户可能再点一次，于是多发起一次授权。
       */
    } catch {
      setError(OAUTH_ERROR_FALLBACK);
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>登录</CardTitle>
        <CardDescription>使用邮箱密码登录，也可以用已经绑定过的第三方账号。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error ? (
          <p
            id="sign-in-error"
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <form onSubmit={handleEmailSignIn} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-in-email">邮箱</Label>
            <Input
              id="sign-in-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              aria-invalid={invalidFields.email || undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sign-in-password">密码</Label>
            <Input
              id="sign-in-password"
              name="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={invalidFields.password || undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
          </div>

          <Button type="submit" disabled={busy}>
            {pending === 'email' ? '正在登录…' : '登录'}
          </Button>
        </form>

        {providers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />或
              <span aria-hidden className="h-px flex-1 bg-border" />
            </p>
            {providers.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => handleProviderSignIn(provider)}
              >
                {pending === provider.id ? '正在跳转…' : `使用 ${provider.label} 登录`}
              </Button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
