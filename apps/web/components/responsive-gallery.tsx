'use client';

/**
 * 生图结果的滑动浏览与全屏查看。
 *
 * 对应 `docs/ARCHITECTURE.md` 7.4：`ResponsiveGallery`（生图结果的滑动与全屏查看）。
 *
 * ## 移动靠滑动，桌面给按钮
 *
 * 移动端用滚动吸附（`snap-x` + `snap-center`）横向滑：这是触屏上唯一不需要教的手势。
 * 桌面端鼠标没有横滑手势，所以补一对翻页按钮——这就是
 * `components/breakpoints.ts` 里说「必须用 JavaScript 判断」的那一处：
 * 按钮的有无改变的是 DOM，不只是样式。
 *
 * 用 `useAtLeast` 而不是 CSS `hidden md:flex` 的代价必须说清楚：服务端快照是
 * `false`，所以服务端渲染出来的 HTML 里没有按钮，桌面端水合后才出现。这个差异是
 * 一个纯新增的浮层按钮，不改变文字与布局流，因此不会看到内容跳动。
 *
 * ## 图片用原生 `<img>`
 *
 * 不用 `next/image`：生图结果来自对象存储的签名直链（`docs/ARCHITECTURE.md` 7.1 红线 3），
 * 域名要到 M7 定下机房与存储后才确定，现在配 `remotePatterns` 只能写一个猜的值。
 * 换成 `next/image` 时记得同时补 `next.config.ts` 的域名白名单，否则线上直接 404。
 */
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/utils';

import { useAtLeast } from './use-media-query';

export type GalleryItem = {
  /** 稳定 key。用下标会在追加结果时把已经打开的查看器指到另一张图上。 */
  id: string;
  src: string;
  /** 图片的文字替代。装饰性图片请给空串，不要省略——省略后屏幕阅读器会念文件名。 */
  alt: string;
  /** 列表里用的缩略图；不给则用 `src`。 */
  thumbnail?: string;
  caption?: string;
};

export type ResponsiveGalleryProps = {
  items: readonly GalleryItem[];
  /** 无结果时的内容。没有它时「还没生成」与「生成失败」在界面上无法区分。 */
  empty?: string;
  className?: string;
};

/**
 * 单张卡片的宽度。
 *
 * 移动端 `85%`：留出下一张的一角，用户一眼就知道可以横滑——不给这个提示，
 * 横向滚动在触屏上完全没有发现性。桌面端一屏三张。
 */
const CARD_WIDTH = 'w-[85%] md:w-[calc((100%_-_1.5rem)/3)]';

export function ResponsiveGallery({ items, empty, className }: ResponsiveGalleryProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLUListElement>(null);
  const isDesktop = useAtLeast('md');

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    /*
     * 少滚一点（90%）让上一屏的最后一张仍露一角，用户能看出这是连续的一排而不是分页。
     * `prefers-reduced-motion` 下换成瞬时跳转：平滑滚动是前庭敏感用户的触发点，
     * 而这里滚动只是换一屏内容，不需要动画来表达任何东西。
     */
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({
      left: direction * track.clientWidth * 0.9,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, []);

  if (items.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{empty}</p>;
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <ul
          ref={trackRef}
          /* `snap-mandatory` 让松手后必定停在某一张上，不会停在两张之间。 */
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1"
        >
          {items.map((item, index) => (
            <li key={item.id} className={cn('shrink-0 snap-center', CARD_WIDTH)}>
              <button
                type="button"
                onClick={() => setViewerIndex(index)}
                className="block w-full overflow-hidden rounded-lg border border-border bg-muted"
                /* 尺寸由图片自己撑开；按钮只负责命中区域，因此不加 padding。 */
              >
                <img
                  src={item.thumbnail ?? item.src}
                  alt={item.alt}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-opacity hover:opacity-90"
                />
              </button>
              {item.caption ? (
                <p className="mt-1.5 truncate text-xs text-muted-foreground">{item.caption}</p>
              ) : null}
            </li>
          ))}
        </ul>

        {isDesktop && items.length > 1 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="上一张"
              onClick={() => scrollByPage(-1)}
              className="absolute top-1/2 left-0 -translate-y-1/2 bg-background/90"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="下一张"
              onClick={() => scrollByPage(1)}
              className="absolute top-1/2 right-0 -translate-y-1/2 bg-background/90"
            >
              <ChevronRight aria-hidden />
            </Button>
          </>
        ) : null}
      </div>

      {viewerIndex !== null ? (
        <ImageViewer
          items={items}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 全屏查看器。
 *
 * 没有用 Radix 的 Dialog：项目里没有装它（`docs/ROADMAP.md` M1 只装了 `react-slot`），
 * 而这里需要的只是「一个遮罩 + Esc 关闭 + 焦点收还」，用原生元素加十来行代码就能做对，
 * 为它引入一个组件库不划算。
 *
 * 三件必须做对、做错了只有键盘与屏幕阅读器用户会遇到的事：
 *
 * 1. **打开时把焦点移进对话框**。不做的话焦点停在背后的画廊上，键盘用户按 Tab 会走进
 *    被遮罩盖住的页面，而看不见自己在哪里。
 * 2. **关闭后把焦点还给打开它的那个按钮**。不做的话焦点掉到 `<body>`，键盘用户被打回
 *    页面开头，得重新 Tab 一遍。
 * 3. **锁住背景滚动**。遮罩是 `fixed`，但底层页面仍会跟着滚轮 / 触摸滚动，
 *    关掉之后用户发现自己已经不在原来的位置。
 *
 * 没有做完整的焦点陷阱（Tab 可以走出对话框）：对话框里只有工具条的按钮，
 * 走出去一两次的代价远小于实现一个有 bug 的陷阱。做焦点陷阱前请先确认这套说法的前提
 * 仍然成立——如果以后往查看器里加了表单或链接，这个取舍就要重新算。
 */
type ImageViewerProps = {
  items: readonly GalleryItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
};

function ImageViewer({ items, index, onIndexChange, onClose }: ImageViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const item = items[index];

  /*
   * 空依赖是刻意的：焦点收还与滚动锁定都只应该在「挂载 / 卸载」这两个时刻做一次。
   * 把 `onClose` 放进依赖会让它在每次父组件重渲染时重跑一遍，于是用户每切一张图，
   * 焦点都被拽回关闭按钮。
   */
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (items.length < 2) return;
      // 首尾相接：查看器里没有「到头了」的提示位，循环比禁用按钮更好理解。
      if (event.key === 'ArrowLeft') {
        onIndexChange((index - 1 + items.length) % items.length);
      }
      if (event.key === 'ArrowRight') {
        onIndexChange((index + 1) % items.length);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [index, items.length, onClose, onIndexChange]);

  // index 越界（例如外部把 items 换短了）：什么都不渲染，不要崩。
  if (!item) return null;

  const iconButton = cn(buttonVariants({ variant: 'outline', size: 'icon' }));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border p-3">
        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.caption}</p>

        {items.length > 1 ? (
          <>
            <button
              type="button"
              aria-label="上一张"
              onClick={() => onIndexChange((index - 1 + items.length) % items.length)}
              className={iconButton}
            >
              <ChevronLeft aria-hidden />
            </button>
            {/* `tabular-nums` 让位数变化时「1 / 9」与「1 / 10」不会左右抖动。 */}
            <span className="text-xs text-muted-foreground tabular-nums">
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              aria-label="下一张"
              onClick={() => onIndexChange((index + 1) % items.length)}
              className={iconButton}
            >
              <ChevronRight aria-hidden />
            </button>
          </>
        ) : null}

        <button
          ref={closeRef}
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className={iconButton}
        >
          <X aria-hidden />
        </button>
      </div>

      {/*
       * 点击空白处关闭：只在事件源就是容器本身时生效，否则点图片也会关掉。
       * 安全区内边距与 `ui/button` 同一处理方式，避免 iPad 的手势条压住图片底边。
       */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img src={item.src} alt={item.alt} className="max-h-full max-w-full object-contain" />
      </div>
    </div>
  );
}
