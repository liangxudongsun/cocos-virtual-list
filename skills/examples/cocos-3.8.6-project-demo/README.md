# 高性能虚拟列表（VirtualList）

Cocos Creator 3.8.x 的通用虚拟列表组件与演示。数据有 10 万条，但屏幕上只创建「可视区 + 缓冲」内的二三十个 item 节点，滚动时通过对象池复用，节点总量恒定。

## 为什么需要它

普通做法是给 10 万条数据创建 10 万个节点：

| | 普通 ScrollView + Layout | VirtualList |
|---|---|---|
| 节点数量 | 10 万 | ~30（只随视口大小变化） |
| 初始化耗时 | 秒级卡死 | 毫秒级 |
| 内存占用 | 数百 MB | 几乎可以忽略 |
| 滚动流畅度 | 卡顿 / 掉帧 | 与数据量无关 |

聊天记录、排行榜、好友列表、邮件系统、无尽加载等大列表场景都适用。

## 目录结构

```
assets/virtual-list/
├── components/
│   └── VirtualList.ts        # 核心组件
└── js/
    └── VirtualListDemo.ts    # 演示脚本：纯代码搭建全部 UI，零手动配置
```

## 快速体验（推荐）

1. 打开一个 Cocos Creator 3.8.x 工程；
2. 把 `components/VirtualList.ts` 和 `js/VirtualListDemo.ts` 拷到项目文件夹下；
3. 新建场景 → 添加 **Canvas** → 在 Canvas 下新建一个空节点 → 挂上 `VirtualListDemo` 脚本；
   > 这个空节点只是"脚本宿主"，**不需要挂任何组件**——ScrollView、Mask、content、item 模板、按钮等整套 UI 都会由脚本在运行时自动创建并挂到它下面；
4. 点运行：看到 10 万条数据流畅滚动，顶部实时显示「存活节点 / 累计创建 / 复用次数」，底部的「跳到底部 / 随机跳转」按钮演示 `scrollToIndex`。

> 演示场景的 UI（ScrollView、Mask、content、item 模板、按钮）全部由脚本在运行时创建，不需要在编辑器里搭任何东西。
>
> 说明两点（避免误读）：
> - **节点数量多不是 bug**：10 万条数据只创建「可视区 + 缓冲」内的几十个节点（屏幕只放得下这么多），层级面板里看到的 `item_0 / item_1 / ...` 就是存活的列表项——这正是虚拟化在工作的证明；`itemTemplate`（隐藏）是唯一的模板节点。
> - **列表区域 = 挂脚本的容器节点**：demo 以宿主节点的 UITransform 尺寸作为列表视口——ScrollView 铺满容器、Mask 正好裁剪容器区域（容器 800×600，列表就只在 800×600 内显示，一屏能放几个由容器高度决定）。宿主节点是纯空节点（无 UITransform）时退回全屏（Canvas 设计分辨率）。要给列表留一块区域，用编辑器新建一个带 UITransform 的 UI 节点并设好尺寸，把脚本挂上去即可。脚本运行时创建的节点已设置为 `UI_2D` 层。

## 在编辑器里手动搭建（正式使用）

1. 在 Canvas 下创建节点层级（编辑器「创建 → UI 组件 → ScrollView」会自动生成标准结构）：

   ```
   ScrollView          ← ScrollView 组件
   └─ view             ← Mask + UITransform（显示区，自动生成）
      └─ content       ← UITransform + VirtualList 组件（本组件挂这里）
         └─ item       ← item 模板（任意样式，会被自动隐藏）
   ```

2. 在 `content` 节点上添加 `VirtualList` 组件（菜单 `UI/VirtualList`）；
3. 按需配置属性：

   | 属性 | 说明 |
   |---|---|
   | `scrollView` | 关联的 ScrollView，可留空（自动沿节点树向上查找） |
   | `itemTemplate` | item 模板，可留空（默认取 content 下第一个子节点） |
   | `vertical` | 勾选 = 垂直列表，取消 = 水平列表 |
   | `itemSize` | item 尺寸（宽 × 高），当前为等尺寸模式 |
   | `paddingTop/Bottom/Left/Right` | 四向内边距 |
   | `gap` | item 间距 |
   | `pixelAlign` | 像素对齐（默认开）：item 落点取整后再设位置，防子像素采样导致纹理发虚/闪烁 |
   | `buffer` | 缓冲行数：可视区外每侧额外缓存的 item 行数（单列列表即前后各 N 个 item，默认 2）。越大快速滚动越不易白屏、节点越多；一般 2~4 足够 |
   | `throttle` | 快速滚动降频（默认开）：滚动很快时自动降刷新率（飞速≈20fps、快速≈30fps、慢速≈60fps），降低快速甩动时的重绑开销——快速滚动时人眼本来看不清内容，降频基本无感；停稳会自动补刷一次保证显示正确。追求极致清晰可关闭 |
   | `autoDowngrade` | 低性能自动降级（默认开，需配合 throttle）：统计每次刷新的耗时，最近 5 次 ≥3 次超 16ms 判定设备吃力，自动把慢速滚动也降到 30fps，无需手动判断设备性能 |
   | `adaptiveBuffer` | 速度自适应缓冲（默认开）：快速甩动时按"未来 6 帧位移"临时扩大缓冲（最多 +4 行）防白屏，停稳自动回落 |
   | `autoCleanOnRecycle` | 回收自动清理（默认开）：回收时自动停 tween、重置缩放/透明度，防复用节点残留旧动画/形变 |
   | `clickSensitivity` | 点击判定位移阈值（像素，默认 8）：按下到抬起的位移超过该值判定为滚动，不触发点击 |
   | `itemCount` | 数据条数 |

4. 在代码里绑定渲染回调：

   ```ts
   import { VirtualList } from './components/VirtualList';

   const vl = contentNode.getComponent(VirtualList)!;
   vl.onItemRender = (item, index) => {
       // 把第 index 条数据渲染到 item 节点上（item 可能是复用的，必须全量绑定）
       item.getChildByName('label').getComponent(Label).string = `第 ${index} 条：${data[index]}`;
   };
   ```

> 关键：`onItemRender` 里必须给**每一项**绑定完整数据——因为 item 节点是被复用的，上一帧它可能显示的是第 5 条，这一帧要显示第 500 条。

## API

| 方法 / 属性 | 说明 |
|---|---|
| `setItemCount(count)` | 修改数据条数，自动重算 content 尺寸并重建可视区 |
| `appendItems(count)` | 追加数据（加载更多）：保持当前位置；若原本在底部则自动贴住新底部 |
| `refresh()` | 数据内容变了（条数不变）时，重渲染当前可见的 item |
| `refreshItem(index)` | 只重渲染第 index 条（不在窗口内则滚到时自然生效） |
| `scrollToIndex(index, time?)` | 滚动到第 index 条（对齐可视区起始边），time 为动画时长（秒）。**远距离跳转建议传 0（立即）**：动画过程中间帧内容无意义且观感差，直接到位最干净 |
| `onItemRender(item, index)` | 渲染回调：item 进入可视区时调用 |
| `onItemRecycle(item, index)` | 回收回调：item 滚出可视区前调用（可选） |
| `onItemClick(item, index)` | 点击回调：内置"按下-抬起位移 ≤ clickSensitivity"的点击判定，滚动不会误触 |
| `aliveCount` | 当前存活的节点数（调试/性能展示用） |
| `totalCreated` | 累计实例化的节点总数，应远小于 itemCount |
| `reusedCount` | 累计复用节点次数 |

## 性能原理

```
可视区（一屏）
┌──────────────┐  ← 实际只创建这个范围内的 item
│  item 10     │
│  item 11     │
│  item 12     │
│  ...         │
└──────────────┘
  ↑ 缓冲（前后各 buffer 行，防快速滚动白屏；默认 2，快速甩动出现白屏再调大）
```

- **滚动时零创建**：item 是 content 的子节点，随 content 一起移动，滚动过程只做「滚出视野的回收进池、滚入视野的从池取出复用」，没有 `instantiate` / `destroy`；
- **静止帧近零成本**：组件在 `update()` 里零分配读 content 位置与视口尺寸（属性读取，无对象分配），位置没变就什么都不做；只有真正滚动的那几帧才调 `getScrollOffset()` 算可见区间——天然覆盖触摸滚动与惯性滚动，比监听高频 SCROLLING 事件更简单可靠；
- **对象池**：回收的节点只是 `active = false` 入池。引擎 `Batcher2D.walk` 对 `activeInHierarchy === false` 的节点直接跳过整棵子树，2D 渲染也没有视口剔除（Mask 只在 GPU 裁剪，不省 CPU 遍历）——这就是"让视口外的节点不存在"有效的源码依据；
- **多列支持**：垂直列表自动按视口宽计算列数，水平列表自动按视口高计算行数；
- **content anchor 无关**：内部按 anchor 换算坐标，编辑器里怎么设 anchor 都行（demo 用 (0,1) 左上角，最直观）；
- **content 主轴不小于视口**：数据不足一屏时也撑满视口，保证 ScrollView 回弹/边界行为正常。

## 注意事项

1. **等尺寸模式**：所有 item 必须同尺寸（`itemSize`）。需要可变高度时，可基于本组件改造：把「stride 公式」换成「index → 累计高度」的前缀和表，可见范围用二分查找定位（O(log n)），布局与回收逻辑不用动。
2. **水平模式的引擎符号坑**：垂直时 `getScrollOffset().y` 与「距顶部已滚距离」同号（正）；水平时 `getScrollOffset().x` 与「距左侧已滚距离」**反号**（引擎 get/scroll 两个 API 的历史不一致）——本组件已按此修正（内部 `scrollPos = vertical ? offset.y : -offset.x`），改造时留意。
3. **回收清理**：item 滚出视野后可能复用给别的 index。如果 item 上挂了 tween 动画、定时器、点击监听或异步加载，请在 `onItemRecycle` 里停掉/解绑（`Tween.stopAllByTarget`、`off` 等），并在 `onItemRender` 里**全量重绑**——残留旧动画/旧闭包是虚拟列表最常见的 bug。
4. **合批优化**：demo 的 item 背景用 Graphics 绘制，方便零资源跑通。正式项目建议 item 背景用**同一张图集**的 Sprite（同纹理同材质会自动合批，draw call 大幅下降）；文字尽量用 BMFont/图集字体，避免每个 Label 一次 draw call。
5. **数据懒加载**：demo 一次性生成 10 万条字符串仅为演示。真实项目在 `onItemRender` 里按 index 实时取数据即可，连数组都不需要。
6. **模板节点**：`content` 下的模板节点会被组件自动隐藏（`active = false`），只作为克隆来源。模板的 UITransform 尺寸建议与 `itemSize` 一致。
7. **不要**在 content 上再挂 `Layout` / `Widget` 等自动布局组件，虚拟列表自己控制 item 位置，两者会打架。

## 扩展方向

- 可变 item 尺寸（高度缓存 + 前缀和二分定位）
- 多模板（不同类型 item）：把单池改为 `typeIndex → Node[]` 的池数组，`onItemRender` 前先按类型取模板
- 滚动到中部对齐（`scrollToIndex` 增加 align 参数）
- 无限下拉加载（监听 `SCROLL_TO_BOTTOM` 后 `setItemCount` 追加数据）
- 吸顶分组头、下拉刷新等，均可在现有 diff 机制上叠加
