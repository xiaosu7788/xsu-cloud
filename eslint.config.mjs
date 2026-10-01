/**
 * 仓库根 ESLint 入口。
 *
 * 规则本体放在 packages/config/eslint，这样它既能被根配置引用，
 * 也能在将来抽成独立包复用。这里只做转发，不写规则。
 *
 * 分层铁律（本仓库唯一不可妥协处）的唯一事实来源是
 * docs/ARCHITECTURE.md 第 2.2 节；改规则前先改文档。
 */
export { default } from './packages/config/eslint/index.mjs';
