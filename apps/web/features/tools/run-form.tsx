'use client';

/**
 * 工具执行表单：按工具声明的字段动态渲染，提交给 `runToolAction`。
 *
 * ## 只接收可序列化的部分
 *
 * `ToolDefinition.run` 是函数，跨不了 server → client 的边界，所以本组件的 props 是
 * `{ slug, fields, sensitive }` 三样纯数据。`sensitive` 虽然只影响一段提示文字，但它必须是
 * 服务端给的那一份：判断标准是「用户会不会往里粘不该被人看到的东西」，客户端自己猜不了。
 *
 * ## 禁止 import `./format`
 *
 * `format.ts` 在运行期 import 了 `@xsu/core`（其 `builtin.ts` 引 `node:crypto`），拖进浏览器包
 * 会直接构建失败。所以这里连耗时也自己拼 `${durationMs} ms`，不从那边借 `formatDuration`。
 * `@xsu/core` 只允许 `import type`——类型在编译后被完整擦除，不会留下运行时依赖。
 *
 * ## 表单在每次提交后被 React 重置
 *
 * `<form action>` 收到函数时，React 会在 action 完成后调用 `form.reset()`，输入框回到初始
 * 状态。这是 React 19 的行为，没有开关可关（要保留内容就得把每个字段做成受控组件，为一条
 * 纯函数工具引一整套客户端状态不划算）。代价是「改一下再跑一次」要重新粘贴，收益是表单
 * 里不残留上一次的输入——对 `base64` 这类敏感工具，残留反而是更糟的一侧。
 *
 * ## 不设 HTML `maxLength`
 *
 * 领域层的上限按**码点**算，HTML 的 `maxlength` 按 **UTF-16 码元**算，emoji 上两者不一致；
 * 而且浏览器对超长粘贴是**静默截断**，用户会拿到一份被截短的 JSON 却看不出来。所以上限只
 * 作为提示文字出现，判定留在服务端（`checkToolInput`）。
 */
import Link from 'next/link';
import { useActionState } from 'react';
import type { ToolField, ToolOutput } from '@xsu/core';

import { runToolAction } from '@/app/(console)/console/tools/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { TOOL_SLUG_FIELD, toolFieldInputName } from './form-fields';
import { consoleToolRunPath } from './routes';
import { INITIAL_TOOL_RUN_STATE } from './run-state';

/** 失败提示条的 id。输入控件的 `aria-describedby` 指过来，读屏才会念出失败原因。 */
const RUN_ERROR_ID = 'tool-run-error';

export type RunFormProps = {
  slug: string;
  fields: readonly ToolField[];
  /** 输入可能含口令或密钥。为真时在表单上明示「运行历史不记内容」。 */
  sensitive: boolean;
};

export function RunForm({ slug, fields, sensitive }: RunFormProps) {
  const [state, formAction, isPending] = useActionState(runToolAction, INITIAL_TOOL_RUN_STATE);
  const failure = state.status === 'error' ? state : null;

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-5">
        {/* 「执行哪个工具」的隐藏字段。与工具字段分属两个命名空间，见 `./form-fields`。 */}
        <input type="hidden" name={TOOL_SLUG_FIELD} value={slug} />

        {sensitive ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            这个工具的输入可能包含口令或密钥：运行历史只记字段名与长度，不记录内容。
          </p>
        ) : null}

        {failure ? (
          <p
            id={RUN_ERROR_ID}
            role="alert"
            className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span>{failure.message}</span>
            {/* 稳定错误码：用户反馈「被拒了」时，这句话能直接对到具体是哪一条失败。 */}
            <span className="font-mono text-xs">{failure.code}</span>
          </p>
        ) : null}

        {fields.map((field) => (
          <ToolFieldControl
            key={field.name}
            field={field}
            invalid={failure?.field === field.name}
            errorId={failure ? RUN_ERROR_ID : undefined}
          />
        ))}

        <Button type="submit" disabled={isPending}>
          {isPending ? '正在执行…' : '执行'}
        </Button>
      </form>

      {state.status === 'ok' ? (
        <RunResult runId={state.runId} output={state.output} durationMs={state.durationMs} />
      ) : null}
    </div>
  );
}

/**
 * 一个输入字段。
 *
 * 三种 `kind` 各渲染一种控件，控件本身不认识工具——`kind` 是工具声明的，这里只做映射，
 * 不判断「这个工具该怎么填」。
 */
function ToolFieldControl({
  field,
  invalid,
  errorId,
}: {
  field: ToolField;
  invalid: boolean;
  errorId: string | undefined;
}) {
  const id = `tool-field-${field.name}`;
  const hintId = `${id}-hint`;
  const describedBy = errorId ? `${hintId} ${errorId}` : hintId;
  const inputName = toolFieldInputName(field.name);
  /* 上限只作提示，不设 maxLength，理由见文件头。 */
  const hint = `${field.required ? '必填' : '选填'}。${field.hint ? `${field.hint} ` : ''}最多 ${field.maxLength} 个字符。`;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{field.label}</Label>

      {field.kind === 'textarea' ? (
        <Textarea
          id={id}
          name={inputName}
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      ) : field.kind === 'select' ? (
        /*
         * 不给「请选择」空选项：默认选中第一项，不存在「没选」这个中间态，也就没有一条必然
         * 被触发的失败分支。必填与取值合法性仍由服务端判。
         */
        <Select
          id={id}
          name={inputName}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          name={inputName}
          type="text"
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      )}

      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/** 一次成功执行的结果。耗时与运行记录入口都在这里，两者是同一个时间点的事实。 */
function RunResult({
  runId,
  output,
  durationMs,
}: {
  runId: string;
  output: ToolOutput;
  durationMs: number;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label="执行结果">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">结果</h2>
        <p className="text-xs text-muted-foreground">
          耗时 {durationMs} ms ·{' '}
          <Link href={consoleToolRunPath(runId)} className="underline underline-offset-2">
            查看运行记录
          </Link>
        </p>
      </div>
      <ToolOutputView output={output} />
    </section>
  );
}

/**
 * 结果展示，按 `kind` 分叉。
 *
 * `text` 用**只读 `<textarea>`** 而不是 `<pre>`：工具的输出常是一整行 base64 或 hash，
 * textarea 点一下就 Ctrl+A / 长按全选，`<pre>` 得手动拖选。`json` 走 `<pre>`，因为格式化后的
 * 换行与缩进是它的全部信息量，不能被文本框的滚动条吃掉。
 */
function ToolOutputView({ output }: { output: ToolOutput }) {
  if (output.kind === 'json') {
    return (
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 text-xs whitespace-pre-wrap break-all">
        {output.text}
      </pre>
    );
  }

  return <Textarea readOnly value={output.text} className="font-mono text-xs break-all" />;
}
