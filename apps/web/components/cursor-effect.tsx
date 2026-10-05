'use client';

/**
 * 鼠标跟随的光晕（**仅深色主题生效**）。
 *
 * ## 它做什么，不做什么
 *
 * 整屏铺一层跟随光标的径向渐变，只在光标周围叠一层极淡的 `--foreground`。深色下
 * foreground 近白，光标处被微微提亮，像一盏跟手的台灯 —— **页面其余部分的明暗完全
 * 不动**，这是它与「整页加一层亮角 / 暗角」的区别。
 *
 * 浅色模式直接不挂载：亮色页面本身亮度高，叠一层只会显得脏，作用方向也相反。
 * CSS 侧另有一道闸门（`app/globals.css` 的 `.dark .cursor-glow[data-visible='1']`），
 * 这里不挂载是为了把 rAF 循环整条省掉，而不是只把它藏起来。
 *
 * ## 几个刻意的实现选择
 *
 * 1. **不用 `mix-blend-mode`**：直接叠加主题感知的半透明渐变，视觉等价，少一层合成，
 *    也不会被祖先的 `isolation` / `transform` 破坏 —— 那两样会悄悄改掉混合的参照层，
 *    而这类失效只在某些页面上出现，很难归因。
 * 2. **`pointermove` 只记坐标，位移在 rAF 里做阻尼插值**：事件频率远高于帧率，
 *    每个事件都写一次样式等于把样式结算放大到每秒上百次。
 * 3. **位移不足 0.5px 不写 DOM**：鼠标静止时零渲染开销。
 * 4. **指针移出窗口时淡出**：否则光晕滞留在窗口边缘，看起来像渲染残留。
 * 5. **触屏设备不渲染**：没有 hover 能力就没有「跟随」这件事，留着只是一个不动光斑。
 * 6. **尊重 `prefers-reduced-motion`**：改成静态跟随、不做插值（插值本身就是动效）。
 *
 * 半径与浓度是 CSS 变量（见 `app/globals.css` 的 `.cursor-glow`），调样式不必改本文件。
 */
import { useEffect, useRef, useState } from 'react';

/** 阻尼系数：越小越「重」、跟随越滞后。 */
const DAMPING = 0.16;

/** 只在具备精确指针（鼠标）的设备上启用。 */
function useHasFinePointer(): boolean {
  const [fine, setFine] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    setFine(query.matches);
    const onChange = () => setFine(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return fine;
}

/**
 * 当前是否处于深色主题。
 *
 * 直接观测 `<html>` 上的 `dark` 类，而不是读 `next-themes` 的状态：
 *
 * - `dark` 类才是真正生效的主题（`components/theme-provider.tsx` 用 `attribute="class"`，
 *   且「跟随系统」时系统变化会重新求值），读它不会与真实渲染分叉；
 * - `useTheme` 需要 `ThemeProvider` 的上下文，组件挂在根布局、provider 之外时它只会
 *   返回默认值。观测 DOM 没有这个位置约束。
 *
 * `MutationObserver` 同时覆盖「用户点切换按钮」与「系统主题变化」两条路径，不必为它们
 * 各写一套订阅。
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/** 系统是否要求减少动效。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * 光晕层。
 *
 * 只有 `active`（精确指针 + 深色）时才挂载；不活跃时返回 `null`，effect 里的 rAF 循环
 * 也随之不启动 —— 省掉的是整条渲染链，不只是视觉。
 */
export function CursorGlow() {
  const fine = useHasFinePointer();
  const dark = useIsDark();
  const reduced = usePrefersReducedMotion();
  const layerRef = useRef<HTMLDivElement>(null);

  const active = fine && dark;

  useEffect(() => {
    if (!active) return;

    // target：指针真实位置；pos：当前渲染位置（逐帧插值逼近 target）。
    const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const pos = { ...target };
    /*
     * 上一次真正写进 DOM 的坐标。初值必须是 ±Infinity 而不是 NaN：`Math.abs(x - NaN)`
     * 得到 NaN，而 `NaN > 0.5` 恒为 false —— 第一帧就会被判定成「没移动过」，CSS 变量
     * 永远写不进去，光晕卡在屏幕中央。
     */
    const written = { x: Infinity, y: Infinity };
    let visible = false;
    let seeded = false;
    let frame = 0;

    const handlePointerMove = (event: PointerEvent) => {
      target.x = event.clientX;
      target.y = event.clientY;
      // 首次移动直接吸附到指针处，避免从屏幕中央「飞」过来。
      if (!seeded) {
        pos.x = target.x;
        pos.y = target.y;
        seeded = true;
      }
      visible = true;
    };

    const handlePointerLeave = () => {
      visible = false;
    };

    const render = () => {
      if (reduced) {
        pos.x = target.x;
        pos.y = target.y;
      } else {
        pos.x += (target.x - pos.x) * DAMPING;
        pos.y += (target.y - pos.y) * DAMPING;
      }

      const layer = layerRef.current;
      if (layer) {
        // 位移不足半像素就不写：鼠标静止时不该产生任何样式重算。
        if (Math.abs(pos.x - written.x) > 0.5 || Math.abs(pos.y - written.y) > 0.5) {
          written.x = pos.x;
          written.y = pos.y;
          layer.style.setProperty('--cursor-x', `${pos.x}px`);
          layer.style.setProperty('--cursor-y', `${pos.y}px`);
        }
        /*
         * 淡入淡出走 `data-visible` 而不是内联 `opacity`：内联会盖掉 CSS 里
         * `--glow-alpha` 的值（`.dark .cursor-glow[data-visible='1']`）。
         */
        const want = visible ? '1' : '0';
        if (layer.dataset.visible !== want) layer.dataset.visible = want;
      }

      frame = requestAnimationFrame(render);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('pointerenter', handlePointerMove);
    frame = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('pointerenter', handlePointerMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, reduced]);

  if (!active) return null;

  /*
   * `aria-hidden`：纯装饰，不该出现在可访问性树里。
   * `pointer-events: none`（CSS）保证它不吃任何点击；`z-[45]` 让它压在导航（z-40）之上、
   * 对话框与 toast（z-50）之下。
   */
  return <div ref={layerRef} aria-hidden className="cursor-glow z-[45]" />;
}
