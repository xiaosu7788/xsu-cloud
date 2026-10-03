import { describe, expect, it } from 'vitest';

import {
  buildRunSummary,
  checkToolInput,
  decideToolRunAccess,
  executeToolFunction,
  findTool,
  isRegisteredToolSlug,
  listTools,
  runTool,
  TOOL_FAILURE,
  TOOL_QUOTA_PER_HOUR_DEFAULT,
  TOOL_QUOTA_WINDOW_MS,
  TOOL_RUN_INPUT_PREVIEW_CHARS,
  TOOL_RUN_OUTPUT_PREVIEW_CHARS,
  type ToolDefinition,
  ToolInputError,
  type ToolRunPorts,
  type ToolRunRecord,
} from '../src/tools';

/**
 * 工具箱领域规则。
 *
 * 锁的是 `docs/PRD.md` 3.3 的四条验收：结构化失败、历史不留敏感原文、单位时间配额、
 * **只能看到自己的运行历史**（跨用户拒绝在本文件与端到端各覆盖一次）。
 *
 * 有一处刻意留白：`runTool` 走不到 `runFailed`。四个内置工具都是纯函数且输入已过机械校验，
 * 抛不出未预期的异常，而注册表是封闭的，测试塞不进会抛错的人造工具。这一档由
 * `executeToolFunction` 的用例直接覆盖；`runTool` 里那条分支的副作用（落一行失败历史）
 * 由 `inputInvalid` 的用例覆盖——两者合起来等价。
 */

const NOW = new Date('2026-03-01T00:00:00.000Z');

/** 假端口：把落的历史与查过的窗口起点记下来，测试直接断言它们。 */
function createPorts(overrides: Partial<ToolRunPorts> = {}) {
  const recorded: ToolRunRecord[] = [];
  const countedSince: Date[] = [];

  const ports: ToolRunPorts = {
    now: () => NOW,
    newRunId: () => `run-${recorded.length + 1}`,
    countRunsSince: async (params) => {
      countedSince.push(params.since);
      return 0;
    },
    recordRun: async (run) => {
      recorded.push(run);
    },
    quotaPerHour: TOOL_QUOTA_PER_HOUR_DEFAULT,
    ...overrides,
  };

  return { ports, recorded, countedSince };
}

/** 断言调用被拒，并返回失败项以便继续查 code / status / cause。 */
function expectFailure(outcome: Awaited<ReturnType<typeof runTool>>) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error('预期失败，实际成功');
  }
  return outcome.failure;
}

/** 取内置工具。取不到直接抛错——测试里不该出现「工具不存在」这种含糊的失败。 */
function builtin(slug: string): ToolDefinition {
  const tool = findTool(slug);
  if (!tool) {
    throw new Error(`内置工具 ${slug} 不在注册表里`);
  }
  return tool;
}

/** 人造工具：只用于覆盖内置四支到不了的输入形态（合计字节超限、select 无选项、执行抛错）。 */
function syntheticTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    slug: 'synthetic',
    name: '人造工具',
    summary: '仅用于测试。',
    sensitive: false,
    fields: [{ name: 'text', label: '文本', kind: 'textarea', required: false, maxLength: 10 }],
    run: () => ({ kind: 'text', text: 'ok' }),
    ...overrides,
  };
}

describe('工具注册表', () => {
  it('按注册顺序列出四个内置工具（展示顺序不在这里排）', () => {
    expect(listTools().map((tool) => tool.slug)).toEqual([
      'json-format',
      'text-stats',
      'base64',
      'hash',
    ]);
  });

  it('按 slug 取到工具；没注册的 slug 一律拿不到', () => {
    expect(findTool('json-format')?.name).toBe('JSON 格式化');
    expect(findTool('nope')).toBeUndefined();
    expect(isRegisteredToolSlug('hash')).toBe(true);
    expect(isRegisteredToolSlug('nope')).toBe(false);
  });

  it('每个工具都声明了元数据与至少一个字段，select 必须有选项', () => {
    for (const tool of listTools()) {
      expect(tool.name.length).toBeGreaterThan(1);
      expect(tool.summary.length).toBeGreaterThan(4);
      expect(tool.fields.length).toBeGreaterThan(0);

      for (const field of tool.fields) {
        expect(field.maxLength).toBeGreaterThan(0);
        expect(field.label.length).toBeGreaterThan(0);

        if (field.kind === 'select') {
          // 没有选项的 select 会把所有人拒成 inputInvalid，属于声明错误。
          expect(field.options?.length ?? 0).toBeGreaterThan(0);
          for (const option of field.options ?? []) {
            expect(option.label.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('输入可能含口令/密钥的工具都声明了 sensitive', () => {
    expect(builtin('hash').sensitive).toBe(true);
    expect(builtin('base64').sensitive).toBe(true);
    expect(builtin('json-format').sensitive).toBe(false);
    expect(builtin('text-stats').sensitive).toBe(false);
  });
});

describe('json-format', () => {
  it('把压缩的 JSON 展开成两格缩进', () => {
    expect(builtin('json-format').run({ text: '{"a":[1,2]}' })).toEqual({
      kind: 'json',
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it('语法坏掉的 JSON 抛 ToolInputError（用户能自己修，不能算 500）', () => {
    expect(() => builtin('json-format').run({ text: '{' })).toThrow(ToolInputError);
  });

  it('经 runTool 时坏 JSON 变成 inputInvalid 400，并落一行失败历史', async () => {
    const { ports, recorded } = createPorts();
    const failure = expectFailure(
      await runTool(ports, { userId: 'u1', slug: 'json-format', input: { text: '{' } }),
    );

    expect(failure).toEqual({ ...TOOL_FAILURE.inputInvalid, field: 'text' });
    expect(failure.status).toBe(400);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe('failed');
    expect(recorded[0]?.errorCode).toBe('TOOL_INPUT_INVALID');
  });
});

describe('text-stats', () => {
  it('按码点数字符、按空白切词、按 UTF-8 数字节', () => {
    expect(builtin('text-stats').run({ text: '你好\n世界' }).text).toBe(
      '字符数：5\n去空白字符数：4\n行数：2\n词数：2\n字节数：13',
    );
  });

  it('emoji 算一个字符（按码点，不按 UTF-16 码元）', () => {
    expect(builtin('text-stats').run({ text: '😀' }).text).toContain('字符数：1');
  });
});

describe('base64', () => {
  it('编码后能原样解回来（含中文与 emoji）', () => {
    const source = '你好, world 😀';
    const encoded = builtin('base64').run({ text: source, mode: 'encode' });
    expect(builtin('base64').run({ text: encoded.text, mode: 'decode' }).text).toBe(source);
  });

  it('从终端复制的折行 Base64 也能解码', () => {
    const encoded = builtin('base64').run({ text: 'a longer text', mode: 'encode' }).text;
    const wrapped = `${encoded.slice(0, 4)}\n${encoded.slice(4)}`;
    expect(builtin('base64').run({ text: wrapped, mode: 'decode' }).text).toBe('a longer text');
  });

  it('长度或字符不合法的输入抛 ToolInputError', () => {
    expect(() => builtin('base64').run({ text: 'abc', mode: 'decode' })).toThrow(ToolInputError);
    expect(() => builtin('base64').run({ text: 'ab$c', mode: 'decode' })).toThrow(ToolInputError);
    expect(() => builtin('base64').run({ text: '====', mode: 'decode' })).toThrow(ToolInputError);
  });

  it('解开不是 UTF-8 的字节抛 ToolInputError，而不是静默替换成乱码', () => {
    const binary = Buffer.from([0xff, 0xfe]).toString('base64');
    expect(() => builtin('base64').run({ text: binary, mode: 'decode' })).toThrow(ToolInputError);
  });
});

describe('hash', () => {
  it('SHA-256 与 SHA-1 的已知向量', () => {
    expect(builtin('hash').run({ text: 'abc', algorithm: 'sha256' }).text).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(builtin('hash').run({ text: 'abc', algorithm: 'sha1' }).text).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
  });

  it('算法取值由 select 白名单拦住，工具函数拿不到未知算法', async () => {
    const { ports, recorded } = createPorts();
    const outcome = await runTool(ports, {
      userId: 'u1',
      slug: 'hash',
      input: { text: 'abc', algorithm: 'md5' },
    });

    expect(expectFailure(outcome).code).toBe('TOOL_INPUT_INVALID');
    expect(recorded[0]?.errorCode).toBe('TOOL_INPUT_INVALID');
  });
});

/** 断言拿到失败项（同步版）。 */
function expectSyncFailure(result: ReturnType<typeof executeToolFunction>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('预期失败，实际成功');
  }
  return result.failure;
}

describe('checkToolInput', () => {
  it('必填字段留空或只有空白 → inputInvalid，并指出是哪个字段', () => {
    const tool = builtin('json-format');
    expect(checkToolInput(tool, {})).toEqual({ ...TOOL_FAILURE.inputInvalid, field: 'text' });
    expect(checkToolInput(tool, { text: '   ' })).toEqual({
      ...TOOL_FAILURE.inputInvalid,
      field: 'text',
    });
  });

  it('可选字段留空是合法输入', () => {
    const tool = syntheticTool();
    expect(checkToolInput(tool, {})).toBeNull();
    expect(checkToolInput(tool, { text: '' })).toBeNull();
  });

  it('select 取值不在选项里 → inputInvalid；合法取值放行', () => {
    const tool = builtin('hash');
    expect(checkToolInput(tool, { text: 'x', algorithm: 'sha256' })).toBeNull();
    expect(checkToolInput(tool, { text: 'x', algorithm: 'sha256 ' })).toEqual({
      ...TOOL_FAILURE.inputInvalid,
      field: 'algorithm',
    });
  });

  it('select 没声明选项时一律拒（声明错误不该变成放行）', () => {
    const tool = syntheticTool({
      fields: [{ name: 'mode', label: '方向', kind: 'select', required: false, maxLength: 8 }],
    });
    expect(checkToolInput(tool, { mode: 'anything' })).toEqual({
      ...TOOL_FAILURE.inputInvalid,
      field: 'mode',
    });
  });

  it('单字段超过 maxLength → inputTooLarge，按码点算（emoji 不吃亏）', () => {
    const tool = syntheticTool({
      fields: [{ name: 'text', label: '文本', kind: 'text', required: false, maxLength: 2 }],
    });
    expect(checkToolInput(tool, { text: '😀😀' })).toBeNull();
    expect(checkToolInput(tool, { text: '😀😀😀' })).toEqual({
      ...TOOL_FAILURE.inputTooLarge,
      field: 'text',
    });
  });

  it('每个字段都不超长但合计超过 64 KiB → inputTooLarge（不指字段）', () => {
    const tool = syntheticTool({
      fields: [
        { name: 'a', label: 'A', kind: 'textarea', required: false, maxLength: 40000 },
        { name: 'b', label: 'B', kind: 'textarea', required: false, maxLength: 40000 },
      ],
    });
    const big = 'a'.repeat(40000);

    expect(checkToolInput(tool, { a: big, b: big })).toEqual(TOOL_FAILURE.inputTooLarge);
  });
});

describe('executeToolFunction', () => {
  it('成功时返回工具输出', () => {
    expect(executeToolFunction(builtin('text-stats'), { text: 'a' })).toEqual({
      ok: true,
      output: { kind: 'text', text: '字符数：1\n去空白字符数：1\n行数：1\n词数：1\n字节数：1' },
    });
  });

  it('ToolInputError → inputInvalid 400，并带出字段名', () => {
    const failure = expectSyncFailure(executeToolFunction(builtin('json-format'), { text: '{' }));
    expect(failure).toEqual({ ...TOOL_FAILURE.inputInvalid, field: 'text' });
  });

  it('其它异常 → runFailed 500，原错误挂在 cause 上交给调用方记日志', () => {
    const boom = new Error('boom');
    const tool = syntheticTool({
      run: () => {
        throw boom;
      },
    });

    const failure = expectSyncFailure(executeToolFunction(tool, { text: 'x' }));
    expect(failure.code).toBe('TOOL_RUN_FAILED');
    expect(failure.status).toBe(500);
    expect(failure.cause).toBe(boom);
  });
});

describe('runTool', () => {
  it('成功：返回输出，并落一行 succeeded（含摘要与字节数）', async () => {
    const { ports, recorded } = createPorts();
    const outcome = await runTool(ports, {
      userId: 'u1',
      slug: 'json-format',
      input: { text: '{"a":1}' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('预期成功，实际失败');
    }
    expect(outcome.output.text).toBe('{\n  "a": 1\n}');
    expect(outcome.runId).toBe('run-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      id: 'run-1',
      userId: 'u1',
      toolSlug: 'json-format',
      status: 'succeeded',
      errorCode: null,
      inputBytes: 7,
      outputBytes: 12,
      createdAt: NOW,
    });
    expect(recorded[0]?.inputSummary).toBe('text={"a":1}');
  });

  it('耗时按注入的时钟算，不读全局时间', async () => {
    let reads = 0;
    const { ports, recorded } = createPorts({
      // 第一次读是起点，之后每次读都比起点晚 7ms——换成读全局时间的实现在这里会飘。
      now: () => {
        reads += 1;
        return reads === 1 ? NOW : new Date(NOW.getTime() + 7);
      },
    });

    const outcome = await runTool(ports, {
      userId: 'u1',
      slug: 'text-stats',
      input: { text: 'a' },
    });
    expect(outcome.ok && outcome.durationMs).toBe(7);
    expect(recorded[0]?.durationMs).toBe(7);
  });

  it('工具不存在 → toolNotFound 404，且不落历史（无法归属到一个工具）', async () => {
    const { ports, recorded } = createPorts();
    const failure = expectFailure(
      await runTool(ports, { userId: 'u1', slug: 'nope', input: { text: 'x' } }),
    );

    expect(failure).toBe(TOOL_FAILURE.toolNotFound);
    expect(failure.status).toBe(404);
    expect(recorded).toEqual([]);
  });

  it('输入不合法 → 先落失败历史再返回（有结果必有记录）', async () => {
    let recordedBeforeReturn = false;
    const { ports } = createPorts({
      newRunId: () => 'run-failed',
      recordRun: async (run) => {
        recordedBeforeReturn = run.errorCode === 'TOOL_INPUT_INVALID';
      },
    });

    const failure = expectFailure(
      await runTool(ports, { userId: 'u1', slug: 'json-format', input: {} }),
    );

    expect(failure.code).toBe('TOOL_INPUT_INVALID');
    expect(recordedBeforeReturn).toBe(true);
  });

  it('低于上限放行；达到上限被拒，且拒绝不落历史（否则会自我放大）', async () => {
    const limit = 3;
    const atLimit = createPorts({ quotaPerHour: limit, countRunsSince: async () => limit });
    const belowLimit = createPorts({ quotaPerHour: limit, countRunsSince: async () => limit - 1 });

    const rejected = expectFailure(
      await runTool(atLimit.ports, { userId: 'u1', slug: 'text-stats', input: { text: 'a' } }),
    );
    expect(rejected).toEqual(TOOL_FAILURE.quotaExceeded);
    expect(rejected.status).toBe(429);
    expect(atLimit.recorded).toEqual([]);

    const allowed = await runTool(belowLimit.ports, {
      userId: 'u1',
      slug: 'text-stats',
      input: { text: 'a' },
    });
    expect(allowed.ok).toBe(true);
    expect(belowLimit.recorded).toHaveLength(1);
  });

  it('配额窗口的起点是「现在减一小时」', async () => {
    const { ports, countedSince } = createPorts();
    await runTool(ports, { userId: 'u1', slug: 'text-stats', input: { text: 'a' } });

    expect(countedSince).toEqual([new Date(NOW.getTime() - TOOL_QUOTA_WINDOW_MS)]);
  });

  it('配额为 0 表示关闭执行，不是「不限」', async () => {
    const { ports } = createPorts({ quotaPerHour: 0 });
    const failure = expectFailure(
      await runTool(ports, { userId: 'u1', slug: 'text-stats', input: { text: 'a' } }),
    );

    expect(failure.code).toBe('TOOL_QUOTA_EXCEEDED');
  });
});

describe('buildRunSummary', () => {
  it('非敏感工具：输入按「字段=值」留预览，字节数按 UTF-8 算', () => {
    const summary = buildRunSummary({
      tool: builtin('text-stats'),
      input: { text: '你好' },
      output: { kind: 'text', text: 'abc' },
    });

    expect(summary).toEqual({
      inputBytes: 6,
      outputBytes: 3,
      inputSummary: 'text=你好',
      outputSummary: 'abc',
    });
  });

  it('非敏感工具：预览超长时截断到上限并补省略号（输入 120 / 输出 500）', () => {
    const tool = syntheticTool({
      fields: [{ name: 'text', label: '文本', kind: 'textarea', required: false, maxLength: 1000 }],
    });
    const summary = buildRunSummary({
      tool,
      input: { text: 'a'.repeat(300) },
      output: { kind: 'text', text: 'b'.repeat(TOOL_RUN_OUTPUT_PREVIEW_CHARS + 20) },
    });

    // 截断发生在拼好的摘要字符串上，所以 `text=` 这 5 个字符也占额度。
    expect(summary.inputSummary).toBe(
      `text=${'a'.repeat(TOOL_RUN_INPUT_PREVIEW_CHARS - 'text='.length)}…`,
    );
    expect(summary.outputSummary).toBe(`${'b'.repeat(TOOL_RUN_OUTPUT_PREVIEW_CHARS)}…`);
    // 预览被截断，字节数仍是完整的——两者口径不同，不能一起截。
    expect(summary.inputBytes).toBe(300);
    expect(summary.outputBytes).toBe(TOOL_RUN_OUTPUT_PREVIEW_CHARS + 20);
  });

  it('敏感工具：输入只留字段名，输出一个字符都不存（长度照记）', () => {
    const summary = buildRunSummary({
      tool: builtin('hash'),
      input: { text: 'hunter2', algorithm: 'sha256' },
      output: { kind: 'text', text: 'deadbeef' },
    });

    expect(summary.inputSummary).toBe('[已脱敏] 字段：text、algorithm');
    expect(summary.outputSummary).toBeNull();
    expect(summary.inputBytes).toBe(13);
    expect(summary.outputBytes).toBe(8);
    expect(JSON.stringify(summary)).not.toContain('hunter2');
    expect(JSON.stringify(summary)).not.toContain('deadbeef');
  });

  it('敏感工具：只列出真正提交了内容的字段；全空则不做摘要', () => {
    const withEmptyField = buildRunSummary({
      tool: builtin('hash'),
      input: { text: 'abc', algorithm: '' },
      output: null,
    });
    expect(withEmptyField.inputSummary).toBe('[已脱敏] 字段：text');
    expect(withEmptyField.outputBytes).toBeNull();
    expect(withEmptyField.outputSummary).toBeNull();

    const allEmpty = buildRunSummary({ tool: builtin('hash'), input: {}, output: null });
    expect(allEmpty.inputSummary).toBeNull();
    expect(allEmpty.inputBytes).toBe(0);
  });

  it('失败历史（没有输出）：输出三项为空，输入摘要照常', () => {
    const summary = buildRunSummary({
      tool: builtin('json-format'),
      input: { text: '{' },
      output: null,
    });

    expect(summary).toEqual({
      inputBytes: 1,
      outputBytes: null,
      inputSummary: 'text={',
      outputSummary: null,
    });
  });
});

describe('decideToolRunAccess', () => {
  it('归属者放行', () => {
    expect(decideToolRunAccess({ viewerId: 'u1', ownerId: 'u1' })).toEqual({ allowed: true });
  });

  it('他人一律拒绝：M2 管理员也不放行（判定里根本没有角色入参）', () => {
    // 「管理员能看他人历史」属于 M5，且必须带审计日志；M2 先按最小权限做。
    expect(decideToolRunAccess({ viewerId: 'admin', ownerId: 'u1' })).toEqual({
      allowed: false,
      failure: TOOL_FAILURE.runForbidden,
    });
  });

  it('拒绝项就是失败码表里那一项，文案与状态码只有一处', () => {
    const decision = decideToolRunAccess({ viewerId: 'u2', ownerId: 'u1' });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error('预期拒绝，实际放行');
    }

    expect(decision.failure).toBe(TOOL_FAILURE.runForbidden);
    expect(decision.failure.status).toBe(403);
    expect(decision.failure.code).toBe('TOOL_RUN_FORBIDDEN');
  });
});
