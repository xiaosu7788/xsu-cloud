/**
 * 全仓库共享的 Prettier 规则。各 workspace 不单独配置，靠向上查找继承。
 *
 * 换行符固定 LF、文件编码 UTF-8 无 BOM，见 AGENTS.md「工程实现」。
 * Markdown 不参与格式化，原因见 .prettierignore。
 *
 * @type {import('prettier').Config}
 */
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
};
