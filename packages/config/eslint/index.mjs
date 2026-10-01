/**
 * ESLint 共享配置本体。
 *
 * 仓库根的 `eslint.config.mjs` 只做转发，规则都在这里，方便将来抽成独立包复用。
 * 分层铁律单独放在 `./layering.mjs`，因为它是 A 级文档的直译，改动必须同步文档。
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { coreRules, integrationsRules } from './layering.mjs';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.next/**',
      '**/coverage/**',
      '**/Temp/**',
      '**/docker/data/**',
      '**/pnpm-lock.yaml',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // M0 只有 Node 侧代码。浏览器侧全局量随 M1 的 apps/web 一起按目录补。
      globals: {
        ...globals.node,
      },
    },
  },
  coreRules,
  integrationsRules,
  // 关掉所有与格式化冲突的规则，格式化交给 Prettier。
  prettier,
];
