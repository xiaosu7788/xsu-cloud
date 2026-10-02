'use client';

/**
 * 主题切换。
 *
 * 做成三选一的分段控件而不是一个「日/月」开关，理由写在 `./theme`：二态开关没法表达
 * 「跟随系统」，用户点一下之后就再也回不到那个状态。
 *
 * 可达性上刻意做了三件事：
 *
 * 1. **选中态是底色与文字色，不是 hover**。`docs/PRD.md` 4.1 明确「hover 不得作为唯一
 *    反馈」——触屏设备根本没有 hover，只靠 hover 表达状态等于移动端永远看不到当前选中项。
 * 2. **每个按钮都有可读的名字**：图标本身 `aria-hidden`，名字走 `aria-label` 与 `sr-only`。
 *    屏幕阅读器念「浅色」而不是「按钮」。
 * 3. **触控目标 ≥44px**：小屏 `size-11`，到桌面才收到 `size-9`（鼠标场景密度优先），
 *    与 `ui/button.tsx` 同一条规则。
 *
 * 用 `aria-pressed` 的按钮组而不是 `role="radio"`：后者要求实现方向键在组内移动焦点的
 * ARIA radiogroup 模式，这里没有实现，硬套一个半成品角色比不用角色更糟——现在三个
 * 按钮各自能 Tab 到、能用 Enter / 空格激活，这才是它们真实的行为。
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

import { cn } from '@/components/utils';

import { THEMES, isThemeChoice, type ThemeChoice } from './theme';

/*
 * 取值到图标 / 文案的映射。
 *
 * 用 `Record<ThemeChoice, ...>` 而不是数组：`satisfies` 会在缺少任何一个取值时编译失败，
 * 于是「给 `THEMES` 加了取值却忘了加按钮」不可能悄悄通过。渲染时按 `THEMES` 的顺序展开，
 * 清单因此只有一份。
 */
const OPTIONS = {
  light: { label: '浅色', Icon: Sun },
  dark: { label: '深色', Icon: Moon },
  system: { label: '跟随系统', Icon: Monitor },
} as const satisfies Record<ThemeChoice, { label: string; Icon: unknown }>;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  /*
   * 首屏不猜当前选中项。
   *
   * `useTheme()` 在服务端渲染时 `theme` 一定是 `undefined`（localStorage 读不到），
   * 直接拿它渲染就会出现「服务端渲染成都没选中、客户端渲染成某个选中」的水合不一致。
   * 挂载后再显示选中态：代价是最多一帧的无选中状态，比水合告警可靠。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = mounted && isThemeChoice(theme) ? theme : null;

  return (
    <div
      role="group"
      aria-label="主题"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-1',
        className,
      )}
    >
      {THEMES.map((value) => {
        const { label, Icon } = OPTIONS[value];
        const selected = active === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex size-11 shrink-0 items-center justify-center rounded-md md:size-9',
              'text-muted-foreground transition-colors',
              'hover:bg-background hover:text-foreground',
              selected && 'bg-background text-foreground shadow-sm',
            )}
          >
            <Icon aria-hidden className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
