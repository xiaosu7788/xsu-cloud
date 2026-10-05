'use client';

/**
 * 数据就绪时的「骨架 → 内容」交叉淡化。
 *
 * 直接写 `{loading ? <Skeleton /> : <内容 />}` 的话，数据回来那一帧骨架被卸载、内容整块
 * 出现 —— 视觉上是「啪」地跳一下。这里让两者短暂重叠：骨架淡出的同时内容淡入，交接处
 * 是连续的。
 *
 * ## 叠放靠 CSS grid，不靠绝对定位
 *
 * `.data-fade > * { grid-area: 1/1 }`（见 `app/globals.css`）把两层放进同一个网格单元，
 * 于是容器高度自动取「骨架与内容中较高的那个」—— 不需要写死高度、也不需要用 `absolute`
 * 定位（后者会让容器高度塌成 0，必须再手写一个高度）。
 *
 * ## 只适合包「成块的内容」
 *
 * 卡片里那种一行高的小骨架（例如一个徽章数字）不要套这层：`grid` 会把行内元素变成块级，
 * 原本和文字同排的占位会独占一行。那种场合直接给它一个淡入即可。
 *
 * 计时用 `window.setTimeout` 而不是 CSS 的 `animationend`：骨架是**卸载**而不是隐藏，
 * 需要一个确切的时刻去改 React 状态，事件监听在「淡出被系统降级成瞬间完成」时不会触发。
 * 380ms 比动画本身的 340ms 略长，留出一帧的余量，避免淡出被截断。
 */
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/components/utils';

export function DataFade({
  loading,
  skeleton,
  children,
  className,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [showSkeleton, setShowSkeleton] = useState(loading);
  const [leaving, setLeaving] = useState(false);
  const [showContent, setShowContent] = useState(!loading);

  useEffect(() => {
    if (loading) {
      setShowSkeleton(true);
      setLeaving(false);
      setShowContent(false);
      return;
    }
    // 数据到了：内容立刻开始淡入，骨架同时开始淡出。
    setShowContent(true);
    setLeaving(true);
    // 淡出动画（约 340ms）跑完后再把骨架从 DOM 摘掉，摘早了就没有淡出可看。
    const timer = window.setTimeout(() => {
      setShowSkeleton(false);
      setLeaving(false);
    }, 380);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return (
    <div className={cn('data-fade', className)}>
      {showSkeleton ? <div className={cn(leaving && 'data-fade-out')}>{skeleton}</div> : null}
      {showContent ? <div className="data-fade-in">{children}</div> : null}
    </div>
  );
}
