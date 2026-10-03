/**
 * 工具箱表单的字段名约定，以及读 `FormData` 的唯一入口。
 *
 * ## 为什么工具输入一律带前缀
 *
 * 执行表单里除了工具自己声明的字段，还要提交一个「执行哪个工具」的隐藏字段。如果两者
 * 共用一个命名空间，某个工具把字段取名叫 `__slug` 就会撞上——撞了以后 `get()` 返回哪一个
 * 取决于 DOM 顺序，是一处不会报错、只在那个工具上暴露的静默故障。
 *
 * 因此：工具声明的字段一律包在 {@link TOOL_FIELD_PREFIX} 里，隐藏字段一律用
 * {@link TOOL_SLUG_FIELD} / {@link FAVORITE_INTENT_FIELD} 这种 `__` 前缀，两边的命名空间
 * 结构上不可能相交。**这个转换只写在这里**，渲染（`run-form.tsx`）与读取（`actions.ts`）
 * 各自调用下面两个函数，不许手写前缀。
 *
 * ## 读值不引入 `features/auth` 的 `readField`
 *
 * `FormData.get()` 返回 `string | File | null`。工具输入只可能是字符串（渲染出来的控件都是
 * 文本类），`File` 与缺失都归一成空字符串——与领域层的 `normalizeToolInput` 同一口径。
 * 这里不抛错：形状不对的值由领域层的必填与长度校验拒掉，那是唯一有判定权的地方。
 */

/**
 * 工具声明字段的前缀。
 *
 * 取 `field.` 而不是 `f_`：它出现在提交表单的键名里，出问题时能一眼看出这是工具字段
 * 而不是某个还没改干净的历史命名。
 */
export const TOOL_FIELD_PREFIX = 'field.';

/**
 * 工具声明字段名 → 提交时的键名。
 *
 * 渲染端用它写 `name`，读取端用 `readToolFieldValue`，两边都不手写前缀——前缀改了只需改
 * 这一个常量，不会出现「表单按新前缀提交、服务端按旧前缀读」这种只表现成「输入是空的」
 * 的故障。
 */
export function toolFieldInputName(name: string): string {
  return `${TOOL_FIELD_PREFIX}${name}`;
}

/** 执行表单里「执行哪个工具」的隐藏字段。 */
export const TOOL_SLUG_FIELD = '__slug';

/** 收藏表单里「这次是收藏还是取消」的隐藏字段。 */
export const FAVORITE_INTENT_FIELD = '__intent';

/** 收藏表单的两种意图。 */
export const FAVORITE_INTENTS = ['add', 'remove'] as const;

export type FavoriteIntent = (typeof FAVORITE_INTENTS)[number];

/**
 * 把 `FormData` 里的一项读成字符串。
 *
 * 名字带前缀的转换在这里完成，所以调用方传的是**工具声明的字段名**（`text`），
 * 而不是提交时的键名（`field.text`）。
 */
export function readToolFieldValue(formData: FormData, name: string): string {
  const value = formData.get(`${TOOL_FIELD_PREFIX}${name}`);
  return typeof value === 'string' ? value : '';
}

/** 读一个普通隐藏字段。缺失或不是字符串都返回空字符串。 */
export function readFormValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * 读收藏表单的意图。
 *
 * 取值不在 {@link FAVORITE_INTENTS} 里时返回 `null`，由调用方决定怎么办（现在是不做任何
 * 改动）——这里不兜底成 `'add'`：那样一个被改坏的表单会静默地执行收藏，
 * 而用户以为自己在取消。
 */
export function readFavoriteIntent(formData: FormData): FavoriteIntent | null {
  const raw = readFormValue(formData, FAVORITE_INTENT_FIELD);
  return FAVORITE_INTENTS.find((intent) => intent === raw) ?? null;
}
