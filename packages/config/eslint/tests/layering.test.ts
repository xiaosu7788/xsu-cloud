import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 分层铁律的故意失败用例。
 *
 * `docs/ROADMAP.md` M0 的退出标准是「在 `packages/core` 里写 `import x from 'next'`
 * 时 `pnpm lint` 必须报错」。这里把它变成可自动执行的断言：加载仓库真实 ESLint 配置，
 * 以 `packages/core` 下的虚拟文件路径去 lint 一段代码，检查违规是否真的出现。
 *
 * 用虚拟路径而不是落盘文件，是为了不让这个「故意违规」的样例被 `pnpm lint` 扫到。
 * 断言只挑 `no-restricted-imports` 的违规，其余规则（如未使用变量）不参与。
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImportSources(filePath: string, code: string) {
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const probe = (filePath: string) => (code: string) => restrictedImportSources(filePath, code);

const coreProbe = probe(path.join(repoRoot, 'packages/core/src/probe.ts'));
const integrationProbe = probe(path.join(repoRoot, 'packages/integrations/s3/probe.ts'));

const coreForbiddenCases: Array<[string, string]> = [
  ['next 主入口', "import next from 'next';\nexport default next;\n"],
  ['next 子路径', "import { headers } from 'next/headers';\nexport { headers };\n"],
  ['react', "import react from 'react';\nexport default react;\n"],
  ['react-dom', "import { render } from 'react-dom';\nexport { render };\n"],
  ['server-only', "import 'server-only';\n"],
  ['集成层包名', "import { upload } from '@xsu/integrations';\nexport { upload };\n"],
  ['集成层相对路径逃逸', "import { upload } from '../../integrations/s3';\nexport { upload };\n"],
];

/**
 * 首个 `lintText` 会把 flat config 与全部插件加载进来，冷启动在本机实测约 6 秒
 * （后续每个用例 5–20 毫秒）。让它落在某个用例里会撞上 vitest 默认的 5 秒单项超时，
 * 于是同一份代码在机器繁忙时随机变红 —— 这里先把这笔开销付掉。
 */
beforeAll(async () => {
  await coreProbe("import { z } from 'zod';\nexport { z };\n");
}, 60_000);

describe('分层铁律：packages/core 不得依赖框架与集成层', () => {
  it.each(coreForbiddenCases)('%s 被拒绝', async (_case, code) => {
    expect(await coreProbe(code)).not.toHaveLength(0);
  });

  it('依赖数据层是允许的（2.2 的方向图允许领域层向下依赖数据层）', async () => {
    const violations = await coreProbe("import { schema } from '@xsu/db';\nexport { schema };\n");
    expect(violations).toHaveLength(0);
  });

  it('不误伤普通第三方依赖与相对导入', async () => {
    const violations = await coreProbe(
      "import { z } from 'zod';\nimport { helper } from './helper';\nexport { z, helper };\n",
    );
    expect(violations).toHaveLength(0);
  });
});

const integrationForbiddenCases: Array<[string, string]> = [
  ['领域层包名', "import { rule } from '@xsu/core';\nexport { rule };\n"],
  ['领域层相对路径逃逸', "import { rule } from '../../core/community';\nexport { rule };\n"],
];

describe('分层铁律：packages/integrations 不得依赖领域层', () => {
  it.each(integrationForbiddenCases)('%s 被拒绝', async (_case, code) => {
    expect(await integrationProbe(code)).not.toHaveLength(0);
  });

  it('不误伤普通第三方依赖', async () => {
    const violations = await integrationProbe(
      "import { S3Client } from '@aws-sdk/client-s3';\nexport { S3Client };\n",
    );
    expect(violations).toHaveLength(0);
  });
});
