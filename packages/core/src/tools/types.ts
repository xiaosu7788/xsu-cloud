/**
 * 工具箱的公共类型与工具侧助手。
 *
 * 单独成文件是为了**避免循环依赖**：`registry.ts` 要用 `builtin.ts` 的工具实例，
 * 而工具实例要实现 `ToolDefinition`。契约放这里，两边都只依赖本文件。
 *
 * 一个工具 = 元数据 + 一个纯函数。**纯**在 M2 是硬约束：不碰网络、不碰磁盘、不进队列，
 * 所以执行可以留在请求路径内。需要重型运行时依赖的工具（ffmpeg、OCR、浏览器自动化）
 * 按 `docs/PRD.md` 3.3 一律不做，要做也得走 worker 并单独立项。
 */

/** 输入控件的形态。表现层按它渲染，不在页面里再判断一次工具类型。 */
export type ToolFieldKind = 'text' | 'textarea' | 'select';

/** `select` 的选项：`value` 是提交值，`label` 是给用户看的。 */
export type ToolSelectOption = { value: string; label: string };

export type ToolField = {
  /** 提交时的字段名，也是运行历史摘要里出现的名字。 */
  name: string;
  label: string;
  kind: ToolFieldKind;
  /** 必填字段为空 → `inputInvalid`。可选字段提交空字符串是合法输入。 */
  required: boolean;
  /** 该字段的**字符数**上限（按码点算，不按字节）。超限 → `inputTooLarge`。 */
  maxLength: number;
  placeholder?: string;
  hint?: string;
  /** `kind === 'select'` 时的取值集合。 */
  options?: readonly ToolSelectOption[];
};

/** 工具输出。`kind` 只影响表现层怎么渲染（等宽文本框还是格式化 JSON）。 */
export type ToolOutput = { kind: 'text' | 'json'; text: string };

/**
 * 提交上来的原始输入。值一定是字符串（表单与 FormData 都是字符串），
 * `undefined` 表示这个字段根本没提交。
 */
export type ToolInput = Record<string, string | undefined>;

/**
 * 工具的**语义**输入错误：用户自己能修，但不属于「必填 / 长度 / 选项」这类机械校验。
 *
 * 例：`json-format` 收到语法坏掉的 JSON。这必须是 400 而不是 500——当成内部故障会让
 * 「用户填错」污染错误日志，也会让用户看到没有信息量的「服务器错误」。
 *
 * 抛这个错误的工具函数由 `runTool` 翻译成 `inputInvalid`；抛其它错误一律是 `runFailed`。
 */
export class ToolInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolInputError';
    this.field = field;
  }
}

/** 读一个字段的值，没提交时返回空字符串。 */
export function readToolField(input: Record<string, string>, name: string): string {
  return input[name] ?? '';
}

/**
 * 工具定义。
 *
 * `sensitive` 决定运行历史记什么（见 `run-tool.ts` 的 `buildRunSummary`）：输入可能含
 * 口令、密钥、token 的工具必须声明 `true`，此时历史里**不存任何原文片段**。
 * 判断标准是「用户会不会往里粘不该被人看到的东西」，声明错了就是数据泄漏。
 */
export type ToolDefinition = {
  /** URL 里出现的标识。改名等于换工具（历史与收藏都按 slug 存）。 */
  slug: string;
  name: string;
  /** 清单页上的一句话说明。 */
  summary: string;
  sensitive: boolean;
  fields: readonly ToolField[];
  /**
   * 执行。入参是**已归一化**的输入：声明过的字段都存在、值为字符串（未提交则 `''`）。
   * 原始值不做 trim——`hash`、`base64` 对首尾空白敏感。
   */
  run: (input: Record<string, string>) => ToolOutput;
};
