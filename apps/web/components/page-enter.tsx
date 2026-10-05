'use client';

/**
 * 页面内容入场：切页时页面里的各个区块依次淡入上浮。
 *
 * ## 两条刻意的约束
 *
 * 1. **外壳不参与**。它只包内容区，侧边栏与顶栏在它外面 —— 否则点一次导航整个侧边栏
 *    都跟着闪一下，用两次就会烦。
 * 2. **不重新挂载子树**。常见写法是给容器加 `key={pathname}` 让 React 重建，但那会丢掉
 *    组件状态（表单里已输入的内容、滚动位置）并重发所有请求。这里改成「移除类 → 强制
 *    reflow → 加回类」来重启 CSS 动画，代价只有一次同步布局。
 *
 * ## 与参考实现的两点差异
 *
 * 1. **触发键是 `usePathname()` 而不是路由对象的 key**。参考实现用 react-router 的
 *    `location.key`（每次导航都变，含查询串变化）。Next 的 App Router 没有这个 key，
 *    这里只取路径名：查询串变化（例如后台列表翻页 `?page=2`）不重播入场动画 ——
 *    翻页时整页重新淡入反而像是页面重新加载了一次。
 * 2. **类名写在首帧的 JSX 里，而不是只在 effect 里加**。`useEffect` 在浏览器绘制之后才
 *    跑，只在 effect 里加类会让首屏先完整显示一帧、再从透明开始动，肉眼可见地闪一下。
 *    写在 JSX 里则动画与首帧同步开始；effect 只负责「切页时重启」。
 *
 * 具体哪些元素动、错开多少，见 `app/globals.css` 的 `.page-enter` 规则；系统开启
 * 「减少动态效果」时那些规则整段被关掉。
 */
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

export function PageEnter({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.classList.remove('page-enter');
    // 读一次 offsetWidth 强制浏览器结算样式，否则「移除 + 立刻加回」会被合并成一次、动画不重播。
    void element.offsetWidth;
    element.classList.add('page-enter');
  }, [pathname]);

  return (
    <div ref={ref} className="page-enter">
      {children}
    </div>
  );
}
