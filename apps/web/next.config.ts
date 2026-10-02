/**
 * Next.js 配置。
 *
 * 只放三件必须用配置解决的事，其余交给代码与文档：
 *
 * 1. **`transpilePackages`**：工作区里的 `packages/*` 把 `exports` 直接指向 TS 源码
 *    （见各包的 `package.json`），Next 默认不编译 `node_modules` 之外的东西，
 *    不声明就会在 `import { getAuth } from '@xsu/platform'` 处报语法错误。
 * 2. **`serverExternalPackages`**：`postgres` 是服务端专用依赖，交给 Node 直接加载，
 *    不进入打包产物。放进打包器只会让它被静态分析一遍，没有收益。
 * 3. **`experimental.authInterrupts` 保持关闭**：Next 的 `forbidden()` 能给出真正的
 *    403 响应，但本项目不打算为一个拒绝页引入实验特性。统一拒绝响应由
 *    `app/(admin)/layout.tsx` 走 `@xsu/core` 的 `ACCESS_DENIED` 渲染，
 *    HTTP 状态码仍是 200 —— 这一条残余风险记在 `docs/ROADMAP.md` M1。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@xsu/core', '@xsu/db', '@xsu/platform'],
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
