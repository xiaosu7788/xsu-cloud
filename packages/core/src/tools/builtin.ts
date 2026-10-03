/**
 * 内置工具。M2 的四支都是纯函数：不碰网络、不碰磁盘、不进队列。
 *
 * 加新工具前先读两条约定：
 *
 * 1. **必须在 `fields` 里声明每一个输入字段。** `runTool` 的校验、运行历史摘要、表现层
 *    的表单全部从这份声明推导，没有第二处地方描述「这个工具要什么输入」。
 * 2. **输入可能含口令/密钥的，`sensitive` 必须是 `true`**（`hash`、`base64` 就是这样）。
 *    声明错了会让运行历史留下原文片段。
 */
import { createHash } from 'node:crypto';

import { type ToolDefinition, ToolInputError, readToolField } from './types';

/** 长文本字段的统一上限。够贴一段 JSON 或一篇文章，又不至于让请求体失控。 */
const LONG_TEXT_MAX_LENGTH = 20000;

/** 哈希算法白名单。取值即 `node:crypto` 的算法名，不让用户自由填。 */
const HASH_ALGORITHMS = [
  { value: 'sha256', label: 'SHA-256' },
  { value: 'sha512', label: 'SHA-512' },
  { value: 'sha1', label: 'SHA-1' },
] as const;

const BASE64_MODES = [
  { value: 'encode', label: '编码（文本 → Base64）' },
  { value: 'decode', label: '解码（Base64 → 文本）' },
] as const;

/** 只接受标准 Base64：长度是 4 的倍数，尾部最多两个 `=`。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 格式化 JSON。语法坏掉的输入抛 `ToolInputError`（400），不是 `runFailed`（500）：
 * 这是用户能自己修的错。
 */
const jsonFormat: ToolDefinition = {
  slug: 'json-format',
  name: 'JSON 格式化',
  summary: '把压缩的 JSON 展开成缩进两格的格式，语法有问题会提示。',
  sensitive: false,
  fields: [
    {
      name: 'text',
      label: 'JSON 文本',
      kind: 'textarea',
      required: true,
      maxLength: LONG_TEXT_MAX_LENGTH,
      placeholder: '{"hello":"world"}',
    },
  ],
  run: (input) => {
    const raw = readToolField(input, 'text');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ToolInputError('text', '这段文本不是合法的 JSON，请检查引号、逗号与括号。', {
        cause: error,
      });
    }

    return { kind: 'json', text: JSON.stringify(parsed, null, 2) };
  },
};

/** 文本统计：字符、去空白字符、行、词、UTF-8 字节。 */
const textStats: ToolDefinition = {
  slug: 'text-stats',
  name: '文本统计',
  summary: '统计字符数、去除空白后的字符数、行数、词数与 UTF-8 字节数。',
  sensitive: false,
  fields: [
    {
      name: 'text',
      label: '文本',
      kind: 'textarea',
      required: true,
      maxLength: LONG_TEXT_MAX_LENGTH,
      placeholder: '把要统计的文本粘进来',
    },
  ],
  run: (input) => {
    const raw = readToolField(input, 'text');
    const words = raw.split(/\s+/).filter((word) => word.length > 0);
    const stats = {
      字符数: [...raw].length,
      去空白字符数: [...raw.replace(/\s+/g, '')].length,
      行数: raw.split(/\r\n|\r|\n/).length,
      词数: words.length,
      字节数: new TextEncoder().encode(raw).length,
    };

    return {
      kind: 'text',
      text: Object.entries(stats)
        .map(([label, value]) => `${label}：${value}`)
        .join('\n'),
    };
  },
};

/**
 * Base64 编解码。
 *
 * `sensitive: true`：粘贴进来的内容经常是 token 或密钥，历史里不存原文片段。
 */
const base64: ToolDefinition = {
  slug: 'base64',
  name: 'Base64 编解码',
  summary: '在文本与 Base64 之间转换。输入可能含密钥，运行历史不记录内容。',
  sensitive: true,
  fields: [
    {
      name: 'text',
      label: '内容',
      kind: 'textarea',
      required: true,
      maxLength: LONG_TEXT_MAX_LENGTH,
      placeholder: '要编码的文本，或要解码的 Base64',
    },
    {
      name: 'mode',
      label: '方向',
      kind: 'select',
      required: true,
      maxLength: 16,
      options: BASE64_MODES,
    },
  ],
  run: (input) => {
    const raw = readToolField(input, 'text');
    const mode = readToolField(input, 'mode');

    if (mode === 'encode') {
      // `node:Buffer` 的 base64 编码是标准的，不需要自己补 `=`。
      return { kind: 'text', text: Buffer.from(raw, 'utf8').toString('base64') };
    }

    // 解码前先宽松地去掉空白：从终端或聊天窗口复制的 Base64 常被折行。
    const compact = raw.replace(/\s+/g, '');
    if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
      throw new ToolInputError('text', '这不是合法的 Base64 文本，请检查字符与长度。');
    }

    const bytes = Buffer.from(compact, 'base64');
    try {
      // 严格解码成 UTF-8：二进制内容不该被静默替换成「」。
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch (error) {
      throw new ToolInputError('text', '解码结果不是合法的 UTF-8 文本，可能不是文本内容。', {
        cause: error,
      });
    }
  },
};

/**
 * 哈希摘要。
 *
 * `sensitive: true`：最常见的使用方式就是核对口令或密钥的散列，
 * 原文留在运行历史里等于把这些东西存了下来。
 */
const hash: ToolDefinition = {
  slug: 'hash',
  name: '哈希摘要',
  summary:
    '计算文本的 SHA-256 / SHA-512 / SHA-1 十六进制摘要。输入可能含口令，运行历史不记录内容。',
  sensitive: true,
  fields: [
    {
      name: 'text',
      label: '内容',
      kind: 'textarea',
      required: true,
      maxLength: LONG_TEXT_MAX_LENGTH,
      placeholder: '要计算摘要的文本',
    },
    {
      name: 'algorithm',
      label: '算法',
      kind: 'select',
      required: true,
      maxLength: 16,
      options: HASH_ALGORITHMS,
    },
  ],
  run: (input) => {
    const raw = readToolField(input, 'text');
    const algorithm = readToolField(input, 'algorithm');

    return { kind: 'text', text: createHash(algorithm).update(raw, 'utf8').digest('hex') };
  },
};

/** 注册表的内容。顺序即清单页的展示顺序，不要在这里排序。 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [jsonFormat, textStats, base64, hash];
