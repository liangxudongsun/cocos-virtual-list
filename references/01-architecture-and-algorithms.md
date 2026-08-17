# 01 · 架构与算法（方案 A：槽位式虚拟列表）

本文给出推荐方案的完整技术细节。完整可运行实现见 `../examples/VirtualListView.ts`（改造起点）。

## 1. 节点结构

```
ScrollView 节点（view，挂 ScrollView + Mask + VirtualListView）
└── content（挂 UITransform，无 Layout）
    ├── itemSlot #0   ← 池化节点，显示数据 firstIndex+0
    ├── itemSlot #1   ← 显示数据 firstIndex+1
    └── ...
```

- content 上**不挂 Layout**：位置全部由虚拟列表按数据模型计算。挂 Layout 会与手动定位互相覆盖，且增删槽位节点触发整容器重排。
- Mask 用 `RECT` 类型（模板测试最便宜的路径）；可见性本来就由虚拟化保证，Mask 只兜底快速甩动/回弹时的越界显示。
- 槽位节点数恒定：`可见数 + 2*buffer (+速度自适应余量)`，与数据总量无关。

## 2. 坐标模型（以纵向为例）

统一用"距内容顶部的距离"作为主轴坐标，避免锚点/世界坐标换算错误：

- `prefix[i]`：第 i 项**顶部**距 content 顶部的距离（含 paddingTop/前行累计）。
- `scrolled s`：视口顶部距 content 顶部的距离。从引擎读：`s = scrollView.getScrollOffset().y`（纵向，顶左原点、向下为正），程序化定位用 `scrollView.scrollToOffset(new Vec2(0, s))`——锚点语义交给引擎处理。
- 第 i 项在视口中可见 ⟺ `prefix[i] < s + viewH && prefix[i] + size[i] > s`。

item 在 content 本地空间的落点（对任意 content 锚点成立）：

```ts
const ct = content.getComponent(UITransform)!;
const topInLocal = (1 - ct.anchorY) * ct.height;          // content 顶边的本地 y
const itemAnchorY = itemTf.anchorY;
const y = topInLocal - prefix[i] - size[i] * (1 - itemAnchorY); // 中心锚点时即 -(prefix + size/2) 平移到顶边系
```

横向同理：`leftInLocal = -ct.anchorX * ct.width`，`x = leftInLocal + prefix[i] + size[i] * itemAnchorX`。锚点数学是虚拟列表移植 bug 的重灾区（2.x 移植常栽在右/上边缘的anchor 修正上）；全部换算收敛到上面两个公式可避免。

**像素对齐**：`Math.round` 后再 setPosition，防止子像素采样带来的纹理闪烁与额外的顶点重排成本（这也是 `pixelAlign` 选项的由来）。

## 3. 等高窗口计算（O(1)）

性能第一：等高 O(1) 是整套方案最快的路径，代价是**所有 item 主轴尺寸必须一致**。多模板允许但必须等尺寸（示例组件会在首次 setCount 时 warn 不一致的配置）；异尺寸模板必须走 §4 不等高模式（O(log n)）——不要让等高模式为异尺寸"开小灶"，那会失去固定 stride 的简单性，还白背了等高模式的复杂度假设。

```ts
const stride = itemSize + spacing;
const line = Math.floor(Math.max(0, s - paddingTop) / stride); // 当前行
const first = line * gridCount;                                // grid: 每行 gridCount 个
const end   = Math.min(total, first + (Math.ceil(viewH / stride) + 1) * gridCount);
// 两端各扩 buffer：
range = [max(0, first - buffer * gridCount), min(total, end + buffer * gridCount)];
```

支持 Grid（背包）：主轴算行号，副轴 `col = index % gridCount` 居中排布。不等高/不等宽/多列动态尺寸 → 用前缀和模式。

## 4. 不等高：前缀和 + 二分（O(log n) 定位）

数据模型两数组：

```ts
sizes: number[];    // 每项主轴尺寸，来自 getItemSize(index) 或绑定后实测回写
prefix: number[];   // prefix[i] = paddingTop + Σ(sizes[k] + spacing), k<i
```

定位视口内起始项 = 在 prefix 上找**第一个 > s 的下标 ans**（lower_bound），起始项 = `ans - 1`（该 item 跨过视口顶），再向后扫到 `prefix[end] >= s + viewH` 停止。两端扩 buffer。

维护规则：
- **追加**（聊天、分页）：只 push size、O(1) 追加 prefix，不动前面。
- **单点尺寸变化**（展开/收起/实测回写）：从该 index 起重建后缀 `O(n - i)`，变化点通常在可视区内，重建量小；批量变化取最小变化 index（此即批量 `updateItemHeights` 的做法）。
- **整表刷新**：全量重建一次 O(n)，配 `setCount`。

## 5. 槽位数组与滚动 diff（核心性能手段）

`slotNodes: (Node|null)[]`，`slotNodes[i]` 显示数据 `firstIndex + i`。滚动后：

```
newFirst ≠ firstIndex 时：
  diff = newFirst - firstIndex
  |diff| ≥ slots  → 全量重绑（快速甩动跳过多个窗口）
  diff > 0（向下）→ slotNodes.splice(0, diff) 的尾部节点 rotate 到末尾，
                    只对这 diff 个"新露出的槽位"调 _bindSlot
  diff < 0（向上）→ 对称：尾部 splice 出来 unshift 到头部，重绑头部 diff 个
  diff === 0      → 本帧零成本早退
```

要点：
- 旋转后**只重绑 |diff| 个节点**，稳定慢滚时每帧通常只有 0~1 个节点需要
取池/回池/调 renderItem，这是"滚动时近零开销"的关键。
- 多模板时同步旋转 `slotTypes[i]`，重绑时若类型不符才换池取节点（即重绑时按 currentPrefabIndex 判断的逻辑）。
- 旋转不改兄弟序也能正确显示（item 不重叠时 z 序无关）；若 item 有投影/跨item悬浮元素需要严格顺序，用 `setSiblingIndex` 显式排一次。

## 6. 对象池

```ts
// typeIndex → Node[]，多模板各归各池
private _pools: Node[][] = [];

private _getNode(type: number): Node {
    const pool = this._pools[type] || (this._pools[type] = []);
    let node = pool.pop();
    if (!node) node = instantiate(this.itemPrefabs[type]);
    node.parent = this.content;
    return node;
}

private _putNode(node: Node, type: number) {
    node.active = false;
    node.removeFromParent();
    this._pools[type].push(node);
}
```

- `active=false` + 脱离渲染树后，批处理器对该节点整棵子树直接跳过，这就是池化省 CPU 的依据。
- `cc.NodePool` 在 3.8.6 可用（属 2.x 兼容层）：单实例对应一种模板，`put` 自动`removeFromParent` 并调 `unuse()`，`get` 空池返回 null。多模板场景要么每模板一个实例，要么用上面的数组池。
- 引擎另有通用池 `js.Pool`：`import { js } from 'cc'` 后用 `js.Pool`（引擎内部也有此类用法）。注意它**不是** cc 顶层导出，`import { Pool } from 'cc'` 拿不到。
- 池是列表组件实例私有的：同一模板被多个列表使用时各自实例化；要跨列表共享节点，需把池提升到独立的池管理器。
- 池**不做状态重置**——重置责任在回收/绑定流程（见 references/02 清单），`NodePool` 的 unuse/reuse 钩子同样只是回调时机，不替你清理。

## 7. 绑定流程（_bindSlot）

```
1. 取池（按模板类型）
2. node.active = true（先激活——Label/RichText 只有 enabledInHierarchy 才立即排版）
3. 设置 UITransform 尺寸（等高模式强制写回模板尺寸，防复用残留）
4. 写位置（第 2 节公式 + 像素对齐）
5. 记录 dataIndex（node 上的专用组件或属性，点击回调用）
6. renderItemFn(node, index)   ← 业务写 Label/Sprite/异步头像
7. [不等高] 实测尺寸 → 与模型不符则回写（第 8 节）
8. [可选] 入场动效
```

点击事件在**节点创建时绑定一次**，回调里读 dataIndex——而不是每次绑定on/off（避免闭包与监听器泄漏；这是虚拟列表最常见的复用 bug 来源）。

## 8. 实测尺寸闭环（不等高必备）

Label/RichText 内容变化后真实尺寸可能变（尤其 MAXIMIZE/SHRINK 模式、RichText 换行）：

```
renderItemFn 之后读 itemTf.height（此时已 active，排版已发生）
if (Math.abs(model[i] - actual) > 1):
    记录 oldS、wasAtEnd = oldS ≥ maxScroll - 1
    sizes[i] = actual; 从 i 起重建 prefix；重设 content 尺寸
    if (wasAtEnd && stickToBottom) → scrollToOffset(新 maxScroll)（聊天贴底）
    else if (变化项整体在视口上方 prefixEnd ≤ s) → scrollToOffset(s + delta)（锚定防跳动）
    markDirty() → 下帧 _updateWindow 重新对齐
```

- 容差 1px 防死循环（浮点抖动会让"回写→重排→再回写"循环）。
- 每个索引最多回写一次的护栏：记录 `_measured: Set<index>`（getItemSizeFn 信任模型时不需要）。
- `wasAtEnd` + 贴底是聊天列表体验的核心：先判"是否原本在底部" → 回写 → 视口锚定（上方变化平移补偿）或贴底，这套流程是聊天列表体验的关键。

## 9. 刷新调度与速度自适应

**基准做法（必须）**：不监听 SCROLLING（它在 touch-move 与惯性期高频发射），而是在组件 `update()` 里轮询：

```ts
update(dt) {
    const s = this._readScroll();
    if (s !== this._lastS) { this._velRaw = s - this._lastS; this._lastS = s; this._dirty = true; }
    if (this._dirty) { this._dirty = false; this._updateWindow(); }  // 每帧最多一次
}
```

比"每 N 次 SCROLLING 刷一次"的计数器更稳（不丢惯性、不受事件频率影响），也比"纯脏标记"多拿了速度信息。

时序说明：组件 `update` 与引擎 ScrollView 的 `update` 执行顺序不确定，窗口刷新最多滞后 content 移动一帧——这正是 buffer 存在的理由之一（缓冲行遮住滞后窗口），buffer=0 时快速滚动边缘可能出现一闪而过的空白。

**分档降频（可选）**：在基准做法之上，速度快时主动跳过部分刷新帧：

```ts
// _velSmooth 为 px/frame，折算 px/s（也可用 dt 精确折算）
const v = Math.abs(this._velSmooth) * 60;
let minIntervalMs = 16;                 // 慢速：每帧刷（60fps）
if (v > 2000) minIntervalMs = 50;       // 飞速：≈20fps
else if (v > 1000) minIntervalMs = 33;  // 快速：≈30fps
if (now - this._lastRefreshMs < minIntervalMs) return;   // 跳过本帧
```

- **正确性铁律**：任何降频都必须配"静止兜底"——位置连续 N 帧不变（或`SCROLL_ENDED` 事件）时强制刷一次，否则停留位置显示的是旧窗口（用 onScrollEnded 兜底；轮询方案里"位置静止且刚经历降频"同理）。
- **低性能自动降级**：统计每次刷新自身耗时（保留 5 帧），≥3 帧超 16ms →minIntervalMs 下限提到 33ms。设备自适应，无需机型白名单。
- **取舍**：降频是"少做"，本架构主体（二分定位 + O(diff) 重绑）是"做得快"。先把单次刷新压到 1~2ms，多数设备已无需降频；仅低端机叠加此层。降频的视觉代价：快速滚动经过的区域内容更不完整（用户看不清，可接受）。
- **排障顺序（先做快、再少做）**：若单次 `_updateWindow` 实测 >2ms（等高）或 >4ms（不等高），先怀疑定位退化成了 O(n)（遍历累计高度 / 全量回收重建），而不是急着加降频——降频救不了 O(n) 的底子。坊间"每次刷新要 30ms"的文章，根因正是 O(n) 扫描而非刷新频率。
  自检：等高定位应是纯公式 O(1)；不等高应对前缀和二分 O(log n)；回收/创建只触碰 |diff| 个节点。

**速度自适应缓冲（可选增强）**：

```ts
// _velSmooth 为平滑后的每帧位移（px/frame）
const stride = this.useDynamicSize ? avgSize + spacing : this.itemSize + spacing;
const extra = clamp(Math.floor(Math.abs(this._velSmooth) * LOOKAHEAD_FRAMES / stride), 0, 4);
// 窗口计算时两端多扩 extra 项；停稳后 _velSmooth→0 自动回落
```

- 动机：快速甩动时，重绑开销（getItemPool+renderItem）可能跟不上位移，边缘露出空白；提前多绑几条可遮盖。
- 取舍：extra 会增加该帧重绑数量，上限要 clamp（建议 ≤4）；先测 blank 是否真发生再开启——多数中低端机在 buffer=1~2 + O(diff) 重绑下已经够用。
- 另一种按**屏**分档的变体（>2000px/s 用 3 屏、>1000 用 2 屏、慢速 1 屏）：更简单粗暴，但重绑量与内存占用更高，建议按条数小步扩展而非整屏跳档。
- 更省的变体：甩动速度超阈值时**暂缓重绑**、只挪位置，速度回落后一次性补绑——代价是快速滚动经过的区域短暂空白（多数产品可接受，即"快速滚过区域短暂空白"的闪跳）。

## 10. content 尺寸与边界

```
contentMainSize = prefix[末] + sizes[末] + footerSpacing   （等高：行数*stride - spacing + padding）
contentTf.contentSize = max(contentMainSize, viewportSize)  // 不小于视口
```

- 取 max 的原因：数据不足一屏时保证回弹/边界计算正常。
- 边界重算时机（易误解）：content/view 的 UITransform 尺寸变化由引擎监听`NodeEventType.SIZE_CHANGED` **自动**重算边界（注册在 onEnable，start() 里也有一处初始计算）；运行期**替换content 节点引用**才走 content setter。改了 contentSize 却发现滚动范围不对时，通常原因不是"没触发重算"，而是改的不是 content 的 UITransform、或 ScrollView 组件当时未启用（onEnable 才挂监听）。

## 11. 常用功能挂接点

- **scrollToIndex(i)**：目标 `s = prefix[i] - paddingTop`，clamp 到 `[0, maxScroll]`，`scrollToOffset(v2(0, s), true)`（或自管 tween 控制缓动）。
- **下拉刷新/上拉加载**：监听 `SCROLL_TO_TOP/SCROLL_TO_BOTTOM`（一次性边界事件，频率安全）；下拉刷新 UI 放 content 外、view 内，靠 offset 驱动（状态机 + 阻尼系数即可实现）。
- **加载更多**：触底回调里请求数据 → `appendItems(n)`（只追加 sizes/prefix 尾部）→防抖（一次未完成期间忽略重复触发）。
- **嵌套列表**：子列表按起手方向认领手势（主轴位移 > 阈值且子列表该轴可滚 → 子列表拦截，否则放行父列表；用静态标志记录当前激活的嵌套子列表；引擎 ScrollView 有 `cancelInnerEvents`）。
- **单条刷新**：`refreshItem(i)`——若 i 在当前窗口内，直接对该槽位重调 renderItemFn；否则只更数据待滚到时自然生效（脏 index 集合兜底）。

## 12. 复杂度总览

| 操作 | 等高 | 不等高 |
|---|---|---|
| 每帧空闲检查 | O(1) | O(1) |
| 滚动一帧（diff 个重绑） | O(1) 定位 + O(diff) | O(log n) 定位 + O(diff) |
| 追加数据 | O(1) | O(1) |
| 单点尺寸变化 | — | O(n - i) 重建后缀 |
| 全量刷新 | O(1)（重算窗口） | O(n) 重建前缀和 |
| 内存/节点数 | O(visible + buffer) | 同左 |
