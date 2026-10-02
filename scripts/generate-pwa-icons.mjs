#!/usr/bin/env node
/**
 * 生成 PWA 图标占位资源（确定性、零依赖）。
 *
 * 为什么是脚本，而不是直接提交 PNG 二进制
 * - 图标几何与配色都是这里的常量，改比例或改主题色只动几行代码，可 review、可 diff、可复现。
 * - 二进制资产每次改版都会往仓库里塞一个无法审查的新 blob，产物的差异等于源码差异才看得懂。
 * - 任何机器上执行 `node scripts/generate-pwa-icons.mjs` 都会重出逐字节相同的文件，
 *   不存在「美术资源只在那台机器上」的隐性依赖。
 *
 * 为什么不接受 AI 生成（或任何位图工具导出）的图标
 * - maskable 图标有一条硬约束：品牌内容必须落在直径 80% 的安全区内，即内容点到中心的最大
 *   距离 ≤ 0.40 × 边长；超出部分会被圆形/方形遮罩裁掉。位图生成过程保证不了这条约束，
 *   产物也无法反推出「最远内容点在哪里」，只能靠肉眼看，等于把约束降级成约定。
 * - 这里的占位标记由代码定义，其最大半径是闭式几何量：圆角方环的外角对角线半径为
 *   √2 × (外半边长 − 外圆角半径) + 外圆角半径，正好等于 markRadius（见 renderIcon）。
 *   因此「是否落在安全区内」只由 MARK_RADIUS_BUDGET_RATIO 决定，不依赖任何观察；
 *   校验脚本再从渲染出的像素里实测一遍（Temp/scripts 下的临时校验脚本）。
 *
 * 配色同源
 * - 背景 #0a0a0a 与 `apps/web/app/globals.css` 里 `.dark` 的 `--background: oklch(0.145 0 0)`
 *   是同一颜色的两种写法，也与 `apps/web/components/theme.ts` 的 `THEME_COLOR.dark = '#0a0a0a'`
 *   同源（该文件已注明 oklch(0.145 0 0) → #0a0a0a）。取值必须三处一起改，否则深色模式下
 *   图标底色与页面底色会出现分界。
 * - 标记用纯白 #ffffff，与背景构成最大对比；它是占位色，不对应某个具体 token 的精确值。
 *
 * 标记形状：圆角方环 + 中心圆点，占位图形，待真实品牌资源替换。
 * 替换时只需保持同样的安全半径约束（maskable ≤ 0.40 × 边长，标准 ≤ 0.45 × 边长）。
 *
 * 关于安全区与背景的关系：背景满幅不透明，所以整幅图每个像素的 alpha 都是 255；
 * 「安全区」约束的是品牌内容的几何范围（标记层），不是背景。校验脚本按此口径实测标记半径。
 *
 * 确定性
 * - 不使用 Date、随机数、locale 相关 API。
 * - 唯一的软边来源是固定的 3×3 超采样：每像素 9 个子样本，alpha 只由落在形状内的子样本数决定。
 * - zlib 压缩参数显式固定，不依赖 zlib 默认值随版本漂移。
 *
 * PNG 编码：8 位 RGBA（IHDR bit depth 8、color type 6、interlace 0），每扫描行前置 1 字节
 * 过滤类型 0，整块 IDAT 交给 zlib.deflateSync，CRC32 自行实现（覆盖 chunk type + data），
 * chunk 顺序固定 IHDR → IDAT → IEND。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/** 输出目录与仓库根都由本文件位置解析，不依赖 process.cwd()。 */
const OUTPUT_DIR = new URL('../apps/web/public/icons/', import.meta.url);
const REPO_ROOT = new URL('../', import.meta.url);

const BACKGROUND_RGB = [0x0a, 0x0a, 0x0a];
const MARK_RGB = [0xff, 0xff, 0xff];

/** 安全区上限（内容点到中心的最大距离 ÷ 边长）。maskable 与标准图标只差这个预算。 */
const SAFE_RADIUS_RATIO = {
  standard: 0.45,
  maskable: 0.4,
};

/** 标记实际半径占安全预算的比例。小于 1 即保证标记落在安全区内，留出验证余量。 */
const MARK_RADIUS_BUDGET_RATIO = 0.88;

/** 标记形状的固定比例，均相对标记半径。 */
const OUTER_CORNER_RATIO = 0.22;
const RING_THICKNESS_RATIO = 0.185;
const DOT_RATIO = 0.175;

/** 超采样位置：像素被分成 3×3 子样本，取每格中心。 */
const SUB_SAMPLE_OFFSETS = [1 / 6, 1 / 2, 5 / 6];
const SUB_SAMPLE_COUNT = SUB_SAMPLE_OFFSETS.length ** 2;

const TARGETS = [
  { file: 'icon-192.png', size: 192, variant: 'standard' },
  { file: 'icon-512.png', size: 512, variant: 'standard' },
  { file: 'icon-maskable-192.png', size: 192, variant: 'maskable' },
  { file: 'icon-maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, variant: 'standard' },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32（IEEE 802.3，与 PNG 规范一致），输入需包含 chunk type 与 data。 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
}

function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`像素缓冲区长度不符：期望 ${width * height * 4}，实际 ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour with alpha
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 每扫描行前置过滤类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形的有符号距离场，≤0 表示点在形状内。参数为半边长与圆角半径。 */
function isInsideRoundedSquare(x, y, halfSide, cornerRadius) {
  const innerHalfSide = halfSide - cornerRadius;
  const qx = Math.abs(x) - innerHalfSide;
  const qy = Math.abs(y) - innerHalfSide;
  const outsideDistance = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2);
  const insideDistance = Math.min(Math.max(qx, qy), 0);
  return outsideDistance + insideDistance - cornerRadius <= 0;
}

function isMarkPoint(x, y, geometry) {
  if (x * x + y * y <= geometry.dotRadius ** 2) {
    return true;
  }
  return (
    isInsideRoundedSquare(x, y, geometry.outerHalfSide, geometry.outerCornerRadius) &&
    !isInsideRoundedSquare(x, y, geometry.innerHalfSide, geometry.innerCornerRadius)
  );
}

/** 由标记半径反推圆角方环的几何参数。 */
function buildGeometry(markRadius) {
  const outerCornerRadius = markRadius * OUTER_CORNER_RATIO;
  const outerHalfSide = (markRadius - outerCornerRadius) / Math.SQRT2 + outerCornerRadius;
  const ringThickness = markRadius * RING_THICKNESS_RATIO;
  return {
    outerHalfSide,
    outerCornerRadius,
    innerHalfSide: outerHalfSide - ringThickness,
    innerCornerRadius: Math.max(outerCornerRadius - ringThickness, 0),
    dotRadius: markRadius * DOT_RATIO,
  };
}

function mix(from, to, coverage) {
  return Math.round(from + (to - from) * coverage);
}

function renderIcon({ size, variant }) {
  // 标记最大半径 = √2 × (外半边长 − 外圆角半径) + 外圆角半径，即这里的 markRadius。
  const safeRadius = size * SAFE_RADIUS_RATIO[variant];
  const markRadius = safeRadius * MARK_RADIUS_BUDGET_RATIO;
  // 防护：MARK_RADIUS_BUDGET_RATIO 一旦被改成 > 1，这里立刻失败，而不是悄悄越界。
  if (markRadius > safeRadius) {
    throw new Error(`标记半径超出安全区：${variant} ${size}，${markRadius} > ${safeRadius}`);
  }
  const geometry = buildGeometry(markRadius);
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const [bgR, bgG, bgB] = BACKGROUND_RGB;
  const [markR, markG, markB] = MARK_RGB;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (const offsetY of SUB_SAMPLE_OFFSETS) {
        for (const offsetX of SUB_SAMPLE_OFFSETS) {
          const px = x + offsetX - center;
          const py = y + offsetY - center;
          if (isMarkPoint(px, py, geometry)) {
            hits += 1;
          }
        }
      }
      const coverage = hits / SUB_SAMPLE_COUNT;
      const at = (y * size + x) * 4;
      pixels[at] = mix(bgR, markR, coverage);
      pixels[at + 1] = mix(bgG, markG, coverage);
      pixels[at + 2] = mix(bgB, markB, coverage);
      pixels[at + 3] = 0xff; // 背景满幅不透明，整幅图 alpha 恒为 255
    }
  }
  return pixels;
}

function main() {
  const outputDir = fileURLToPath(OUTPUT_DIR);
  const repoRoot = fileURLToPath(REPO_ROOT);
  mkdirSync(outputDir, { recursive: true });

  for (const target of TARGETS) {
    const png = encodePng(target.size, target.size, renderIcon(target));
    const absolutePath = fileURLToPath(new URL(target.file, OUTPUT_DIR));
    writeFileSync(absolutePath, png);
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
    console.log(`${relativePath} ${target.size}x${target.size} ${png.length} bytes`);
  }
}

try {
  main();
} catch (error) {
  console.error(`生成 PWA 图标失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
