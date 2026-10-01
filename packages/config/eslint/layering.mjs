/**
 * 分层铁律的唯一实现。
 *
 * 事实来源：`docs/ARCHITECTURE.md` 第 2.2 节（A 级文档）。本文件只做翻译，
 * 不新增加规则；代码与文档冲突时以文档为准，并立刻改回来。
 *
 * 为什么用包名 + 路径两种写法：
 * - 包名（`@xsu/core`）是正常的跨包引用方式，靠它拦住绝大多数违规；
 * - 路径写法用于拦住绕过包名的相对逃逸（`../../integrations/s3`）。
 *   相对路径的深度无法预先穷举，因此这里用「任意层级 + 目标目录」的宽松写法。
 *   代价是理论上会误伤同名子目录（例如 core 内部真的有个 integrations/ 子目录）；
 *   真遇到这种情况就改目录名，不要放宽规则。
 */

/** 工作区包名。跨包引用一律走包名，ESLint 才能只按名字判死。 */
export const PACKAGES = {
  web: '@xsu/web',
  core: '@xsu/core',
  db: '@xsu/db',
  platform: '@xsu/platform',
  shared: '@xsu/shared',
  integrations: '@xsu/integrations',
};

const LAYER_DOC = 'docs/ARCHITECTURE.md 2.2';

/** 一个包目录下需要接受检查的源文件。 */
const sources = (packageDir) => [`${packageDir}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`];

const forbidden = (name, reason) => ({ name, message: `${reason}（${LAYER_DOC}）` });
const forbiddenGroup = (group, reason) => ({ group, message: `${reason}（${LAYER_DOC}）` });

/**
 * 领域层：纯 TypeScript。
 * 不得依赖任何框架、集成层与表现层；依赖数据层是允许的（见 2.2 的方向图）。
 */
export const coreRules = {
  files: sources('packages/core'),
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          forbidden('next', '领域层不得依赖任何框架'),
          forbidden('react', '领域层不得依赖任何框架'),
          forbidden('react-dom', '领域层不得依赖任何框架'),
          forbidden('server-only', '领域层不得依赖任何框架'),
          forbidden(PACKAGES.integrations, '领域层不得依赖集成层'),
          forbidden(PACKAGES.web, '领域层不得依赖表现层'),
        ],
        patterns: [
          forbiddenGroup(['next/*'], '领域层不得依赖任何框架'),
          forbiddenGroup(['react/*', 'react-dom/*'], '领域层不得依赖任何框架'),
          forbiddenGroup(['**/integrations', '**/integrations/**'], '领域层不得依赖集成层'),
          forbiddenGroup(['**/apps/web', '**/apps/web/**'], '领域层不得依赖表现层'),
        ],
      },
    ],
  },
};

/**
 * 集成层：适配器只做翻译，不知道业务规则。
 * 不得依赖领域层与表现层；依赖数据层的类型是允许的。
 */
export const integrationsRules = {
  files: sources('packages/integrations'),
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          forbidden(PACKAGES.core, '集成层只做翻译，不得依赖领域层'),
          forbidden(PACKAGES.web, '集成层不得依赖表现层'),
        ],
        patterns: [
          forbiddenGroup(['**/core', '**/core/**'], '集成层只做翻译，不得依赖领域层'),
          forbiddenGroup(['**/apps/web', '**/apps/web/**'], '集成层不得依赖表现层'),
        ],
      },
    ],
  },
};
