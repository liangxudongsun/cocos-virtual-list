/**
 * VirtualListView —— 槽位式虚拟列表实现（Cocos Creator 3.8.x）
 *
 * 设计说明见同目录 ../references/01-architecture-and-algorithms.md。
 * 节点结构要求：
 *
 *   本节点（挂 ScrollView + Mask(RECT) + 本组件）
 *   └── content（挂 UITransform，不挂 Layout/Widget）
 *
 * 核心特性：
 *  - 等高 O(1) / 不等高（前缀和+二分）两种窗口定位，等高支持 Grid 多列
 *  - 槽位 diff 旋转：稳定滚动时每帧只重绑 0~diff 个节点
 *  - 多模板对象池（typeIndex → Node[]）
 *  - update() 轮询 content 位置驱动刷新（每帧最多一次，天然覆盖惯性滚动）
 *  - 可选速度自适应缓冲（快速甩动时提前多绑，防边缘白屏）
 *  - 不等高实测回写闭环：视口锚定 / 聊天贴底
 *
 * 有意省略（按需自行扩展）：下拉刷新 UI 状态机、分页吸附、
 * 嵌套手势认领、入场动效。
 */
import {
    _decorator, Component, Node, Prefab, instantiate, EventTouch,
    UITransform, ScrollView, Vec2,
} from 'cc';

const { ccclass, property } = _decorator;

export type RenderItemFn = (node: Node, index: number) => void;
export type GetItemSizeFn = (index: number) => number;          // 主轴尺寸（同步纯函数）
export type GetItemTypeFn = (index: number) => number;          // 模板类型索引
export type OnItemClickFn = (node: Node, index: number) => void;
export type OnRecycleFn = (node: Node) => void;                  // 回收时业务清理（停 tween、撤异步等）

const CLICK_SLOP = 8;          // 点击判定的位移容差（px）
const MEASURE_TOL = 1;         // 尺寸回写容差，防浮点抖动死循环
const MAX_EXTRA_BUFFER = 4;    // 速度自适应缓冲上限（行数）
const LOOKAHEAD_FRAMES = 6;    // 速度外推帧数

interface ItemSlot { node: Node | null; type: number; index: number; }

@ccclass('VirtualListView')
export class VirtualListView extends Component {
    // ---------------- 编辑器属性 ----------------

    @property({ type: Prefab, tooltip: '单模板：item 预制体（多模板改用 itemPrefabs + getItemTypeFn）' })
    public itemPrefab: Prefab | null = null;

    @property({ type: [Prefab], tooltip: '多模板：按类型索引排列的预制体数组' })
    public itemPrefabs: Prefab[] = [];

    @property({ tooltip: '主方向间距' })
    public spacing = 0;

    @property({ tooltip: '头部间距（纵向为顶部，横向为左侧）' })
    public paddingTop = 0;

    @property({ tooltip: '尾部间距' })
    public paddingBottom = 0;

    @property({ min: 1, tooltip: '行/列数（仅等高模式；纵向为列数，横向为行数）' })
    public gridCount = 1;

    @property({ tooltip: '副方向间距（Grid 列间距）' })
    public gridSpacing = 0;

    @property({ min: 0, max: 8, tooltip: '可视区两侧各多绑定的行数' })
    public buffer = 1;

    @property({ tooltip: '开启后按滚动速度临时扩大缓冲（防快速甩动白屏）' })
    public speedAdaptiveBuffer = true;

    @property({ tooltip: '聊天模式：数据/尺寸变化时若原本贴底则保持贴底' })
    public stickToBottom = false;

    @property({ tooltip: '落点取整，防子像素闪烁' })
    public pixelAlign = true;

    // ---------------- 业务回调（代码注入） ----------------

    /** 必填。绑定数据：写 Label/Sprite/异步头像等。异步回调需自查 node.isValid 与 dataIndex。 */
    public renderItemFn: RenderItemFn | null = null;
    /** 提供不等高尺寸（主轴）。设置后进入动态尺寸模式（Grid 自动退化为单列）。 */
    public getItemSizeFn: GetItemSizeFn | null = null;
    /** 多模板类型索引（对应 itemPrefabs 下标）。缺省 0。 */
    public getItemTypeFn: GetItemTypeFn | null = null;
    public onItemClickFn: OnItemClickFn | null = null;
    /** 回收节点时回调：业务在这里停 tween、取消未完成的异步加载、清定时器。 */
    public onRecycleFn: OnRecycleFn | null = null;

    // ---------------- 内部状态 ----------------

    private _scrollView: ScrollView | null = null;
    private _content: Node | null = null;
    private _contentTf: UITransform | null = null;
    private _viewTf: UITransform | null = null;
    private _vertical = true;

    private _totalCount = 0;
    private _sizes: number[] = [];        // 动态模式：主轴尺寸
    private _prefix: number[] = [];       // 动态模式：prefix[i] = 项 i 顶部距内容顶部
    private _contentMainSize = 0;

    private _itemMainSize = 100;          // 等高模式：类型 0 模板的主轴尺寸
    private _itemCrossSize = 100;
    private _typeSizes = new Map<number, { main: number; cross: number }>();

    private _slots: ItemSlot[] = [];
    private _firstIndex = 0;
    private _pools: Node[][] = [];

    private _lastPosX = Number.NaN;
    private _lastPosY = Number.NaN;       // content 位置缓存（零分配的变更检测）
    private _scrollPos = 0;
    private _velSmooth = 0;
    private _dataDirty = false;
    private _pendingCount = -1;
    private _clickStart = new Vec2();
    private _checkedMultiTemplate = false; // 等高多模板等尺寸检查只做一次（性能第一：不进热路径）

    // ---------------- 生命周期 ----------------

    protected onLoad(): void {
        this._scrollView = this.node.getComponent(ScrollView);
        if (!this._scrollView || !this._scrollView.content) {
            console.error(`[VirtualListView] ${this.node.name} 需要同节点 ScrollView 且已绑定 content`);
            return;
        }
        this._content = this._scrollView.content;
        this._contentTf = this._content.getComponent(UITransform);
        this._viewTf = this.node.getComponent(UITransform);
        this._vertical = this._scrollView.vertical || !this._scrollView.horizontal;

        if (this._pendingCount >= 0) {
            const n = this._pendingCount;
            this._pendingCount = -1;
            this.setCount(n);
        }
    }

    protected onDestroy(): void {
        for (const pool of this._pools) {
            for (const node of pool) {
                node.off(Node.EventType.TOUCH_START, this._onItemTouchStart, this);
                node.off(Node.EventType.TOUCH_END, this._onItemTouchEnd, this);
                node.destroy();
            }
        }
        this._pools = [];
        this._slots = [];
    }

    protected update(_dt: number): void {
        if (!this._scrollView) return;
        this.contentTf(); // 同步运行期被外部替换的 content 节点引用（一次引用比较，近零成本）
        const content = this._content;
        if (!content || this._totalCount <= 0) return;

        // 数据脏（append/setItemSize 等）：全量重对齐一次
        if (this._dataDirty) {
            this._dataDirty = false;
            this._scrollPos = this.readScrollPos();
            this.updateWindow(true);
            return;
        }

        // 1) 零分配的变更检测：content 位置没变（静止）就不做任何事
        const pos = content.position;
        if (pos.x === this._lastPosX && pos.y === this._lastPosY) {
            this._velSmooth = 0; // 停稳后速度归零，自适应缓冲回落
            return;
        }
        this._lastPosX = pos.x;
        this._lastPosY = pos.y;

        // 2) 读滚动距离（getScrollOffset 每次分配一个 Vec2，仅在真正滚动时调用）
        const s = this.readScrollPos();
        this._velSmooth = this._velSmooth * 0.6 + (s - this._scrollPos) * 0.4;
        this._scrollPos = s;

        // 3) 每帧最多一次窗口刷新（references/01 §9：优于监听高频 SCROLLING 事件）
        this.updateWindow(false);
    }

    // ---------------- 公开 API ----------------

    /** 设置总条数并重置到顶部（等价于整表刷新）。传 0 清空并回收全部槽位。 */
    public setCount(count: number): void {
        if (!this._scrollView) { this._pendingCount = count; return; }
        this._totalCount = Math.max(0, count | 0);
        this.initLayoutData();
        this.ensureSlots();
        if (this._totalCount <= 0) {
            // updateWindow 对空表会早退，这里必须显式回收，否则残留最后一个 item
            for (const slot of this._slots) this.recycleSlot(slot);
            this._firstIndex = 0;
            return;
        }
        this.scrollTo(0, 0);
        this.updateWindow(true);
    }

    /** 追加条数（动态模式由 getItemSizeFn 供给新尺寸）。 */
    public appendItems(count: number): void {
        if (count <= 0 || this._totalCount <= 0) { if (count > 0) this.setCount(count); return; }
        this._scrollPos = this.readScrollPos(); // 回调时机不定，先刷新缓存再判定贴底
        const atEnd = this.isAtEnd();
        this._totalCount += count;
        if (this.isDynamic()) {
            for (let i = this._sizes.length; i < this._totalCount; i++) {
                this.appendOneSize(this.getItemSizeFn ? this.getItemSizeFn(i) : this._itemMainSize);
            }
        }
        this.applyContentSize();
        if (this.stickToBottom && atEnd) this.scrollToBottom(false);
        this._dataDirty = true;
    }

    /** 单点尺寸更新（展开/收起/异步回写）。自动做视口锚定与贴底。 */
    public setItemSize(index: number, size: number): void {
        if (!this.isDynamic() || index < 0 || index >= this._totalCount) return;
        if (Math.abs((this._sizes[index] ?? 0) - size) <= MEASURE_TOL) return;

        this._scrollPos = this.readScrollPos(); // 回调时机不定，先刷新缓存
        const atEnd = this.isAtEnd();
        const oldS = this._scrollPos;
        const itemEnd = (this._prefix[index] ?? 0) + (this._sizes[index] ?? 0);
        const aboveViewport = itemEnd <= oldS + 0.5;   // 变化项整体在视口上方
        const delta = size - (this._sizes[index] ?? 0);

        this._sizes[index] = size;
        this.rebuildPrefixFrom(index);
        this.applyContentSize();

        if (atEnd && this.stickToBottom) this.scrollToBottom(false);
        else if (aboveViewport) this.scrollTo(oldS + delta, 0); // 锚定：抵消上方尺寸变化
        this._dataDirty = true;
    }

    /** 刷新窗口内单条（不在窗口则只更数据，滚到时自然生效）。 */
    public refreshItem(index: number): void {
        const slotIdx = index - this._firstIndex;
        const slot = this._slots[slotIdx];
        if (slot && slot.node && slot.index === index) this.renderItemFn?.(slot.node, index);
    }

    public scrollToIndex(index: number, animate = false, timeInSecond = 0.3): void {
        this.scrollTo(this.itemStart(index) - this.paddingTop, animate ? timeInSecond : 0);
    }

    public scrollToBottom(animate = false, timeInSecond = 0.3): void {
        this.scrollTo(this.maxScroll(), animate ? timeInSecond : 0);
    }

    /** 数据/尺寸变化后请求下一帧全量重对齐。 */
    public markDirty(): void { this._dataDirty = true; }

    /** 视口尺寸变化（Widget 对齐、屏幕旋转）后调用。 */
    public refreshViewport(): void {
        this.applyContentSize();
        this.ensureSlots();
        this._dataDirty = true;
    }

    // ---------------- 布局模型 ----------------

    private contentTf(): UITransform {
        // 支持运行期 content 被外部替换（content setter 会触发引擎重算滚动边界）
        if (this._scrollView!.content && this._scrollView!.content !== this._content) {
            this._content = this._scrollView!.content;
            this._contentTf = this._content.getComponent(UITransform);
        }
        return this._contentTf!;
    }

    private isDynamic(): boolean { return this.getItemSizeFn != null; }

    /** 动态模式不支持 Grid，统一按单列处理。 */
    private cols(): number { return this.isDynamic() ? 1 : this.gridCount; }

    private initLayoutData(): void {
        if (this.isDynamic()) {
            this._sizes.length = 0;
            this._prefix.length = 0;
            for (let i = 0; i < this._totalCount; i++) {
                this.appendOneSize(this.getItemSizeFn!(i));
            }
        } else {
            const t = this.templateSize(this.typeOf(0));
            this._itemMainSize = t.main;
            this._itemCrossSize = t.cross;
            // 防御（性能第一）：等高模式的 O(1) 窗口定位依赖固定 stride，要求所有模板主轴尺寸一致。
            // 异尺寸模板会静默摆错；此检查只在首次 setCount 执行一次（量完的节点进池复用），
            // 绝不进入滚动/绑定热路径。异尺寸模板的正确用法是 getItemSizeFn 不等高模式（O(log n)）。
            if (this.getItemTypeFn && this.itemPrefabs.length > 1 && !this._checkedMultiTemplate) {
                this._checkedMultiTemplate = true;
                for (let type = 1; type < this.itemPrefabs.length; type++) {
                    const s = this.templateSize(type);
                    if (Math.abs(s.main - this._itemMainSize) > MEASURE_TOL) {
                        console.warn(
                            `[VirtualListView] ${this.node.name} 等高模式下模板 #${type} 主轴尺寸(${s.main})` +
                            `与模板 #0(${this._itemMainSize})不一致，等高模式会摆错。` +
                            `异尺寸模板请改用 getItemSizeFn 走不等高模式。`,
                        );
                        break;
                    }
                }
            }
        }
        this.applyContentSize();
    }

    private appendOneSize(size: number): void {
        const prev = this._prefix.length
            ? this._prefix[this._prefix.length - 1] + this._sizes[this._sizes.length - 1] + this.spacing
            : this.paddingTop;
        this._sizes.push(size);
        this._prefix.push(prev);
    }

    private rebuildPrefixFrom(index: number): void {
        for (let i = index; i < this._sizes.length; i++) {
            this._prefix[i] = i === 0
                ? this.paddingTop
                : this._prefix[i - 1] + this._sizes[i - 1] + this.spacing;
        }
    }

    private applyContentSize(): void {
        const last = this._totalCount - 1;
        this._contentMainSize = last < 0
            ? 0
            : this.isDynamic()
                ? this._prefix[last] + this._sizes[last] + this.paddingBottom
                : this.paddingTop + Math.ceil(this._totalCount / this.cols()) * (this._itemMainSize + this.spacing)
                  - this.spacing + this.paddingBottom;
        this._contentMainSize = Math.max(0, this._contentMainSize);

        const ct = this.contentTf();
        // content 不小于视口，保证回弹/边界正常（references/01 §10）
        const minMain = this._vertical ? this._viewTf!.height : this._viewTf!.width;
        const main = Math.max(this._contentMainSize, minMain);
        if (this._vertical) ct.height = main;
        else ct.width = main;
    }

    private templateSize(type: number): { main: number; cross: number } {
        let t = this._typeSizes.get(type);
        if (!t) {
            const node = this.newNode(type);
            const uit = node.getComponent(UITransform)!;
            t = this._vertical ? { main: uit.height, cross: uit.width }
                               : { main: uit.width, cross: uit.height };
            this._typeSizes.set(type, t);
            this.putNode(node, type);
        }
        return t;
    }

    private typeOf(index: number): number {
        return this.getItemTypeFn ? this.getItemTypeFn(index) : 0;
    }

    private itemStart(index: number): number {
        if (this.isDynamic()) return this._prefix[index] ?? 0;
        return this.paddingTop + Math.floor(index / this.cols()) * (this._itemMainSize + this.spacing);
    }

    private itemMainSize(index: number): number {
        return this.isDynamic() ? (this._sizes[index] ?? 0) : this._itemMainSize;
    }

    private stride(): number {
        if (this.isDynamic()) {
            // 仅用于槽位规划与速度缓冲估算，窗口定位本身走二分，不依赖此值
            const n = Math.min(this._sizes.length, 32);
            let sum = 0;
            for (let i = 0; i < n; i++) sum += this._sizes[i];
            return (n ? sum / n : 100) + this.spacing;
        }
        return this._itemMainSize + this.spacing;
    }

    private viewMain(): number { return this._vertical ? this._viewTf!.height : this._viewTf!.width; }

    private maxScroll(): number { return Math.max(0, this._contentMainSize - this.viewMain()); }

    private isAtEnd(): boolean { return this._scrollPos >= this.maxScroll() - 1; }

    // ---------------- 滚动读写（符号约定见 references/01 §2） ----------------

    private readScrollPos(): number {
        // 纵向：offset.y = 距顶部已滚距离（正）；
    // 横向：offset.x 与"距左侧已滚距离"反号（引擎 get/scroll 两 API 的历史不一致）
        const off = this._scrollView!.getScrollOffset();
        const s = this._vertical ? off.y : -off.x;
        return Math.max(0, Math.min(this.maxScroll(), s));
    }

    private scrollTo(s: number, timeInSecond: number): void {
        const clamped = Math.max(0, Math.min(this.maxScroll(), s));
        this._scrollView!.scrollToOffset(
            this._vertical ? new Vec2(0, clamped) : new Vec2(clamped, 0),
            timeInSecond > 0 ? timeInSecond : undefined,
        );
        this._scrollPos = clamped;
    }

    // ---------------- 窗口计算与槽位旋转 ----------------

    private ensureSlots(): void {
        const stride = Math.max(1, this.stride());
        const maxExtra = this.speedAdaptiveBuffer ? MAX_EXTRA_BUFFER : 0;
        // 预留最坏情况的槽位：速度缓冲只是扩大窗口，不临时建节点
        const lines = Math.ceil(this.viewMain() / stride) + (this.buffer + maxExtra) * 2 + 1;
        const slots = Math.min(lines * this.cols(), Math.max(1, this._totalCount));
        while (this._slots.length < slots) this._slots.push({ node: null, type: -1, index: -1 });
        if (this._slots.length > slots) {
            for (let i = slots; i < this._slots.length; i++) this.recycleSlot(this._slots[i]);
            this._slots.length = slots;
        }
    }

    /** 当前应绑定的数据窗口 [start, end)。 */
    private calcRange(): { start: number; end: number } {
        const n = this._totalCount;
        if (n <= 0) return { start: 0, end: 0 };
        const s = this._scrollPos;
        const extra = this.speedAdaptiveBuffer
            ? Math.min(MAX_EXTRA_BUFFER, Math.floor(Math.abs(this._velSmooth) * LOOKAHEAD_FRAMES / this.stride()))
            : 0;
        const pad = (this.buffer + extra) * this.cols();

        if (this.isDynamic()) {
            // 二分：第一个 prefix > s 的下标，其前一项跨过视口顶（references/01 §4）
            let l = 0, r = n, ans = n;
            while (l < r) {
                const m = (l + r) >> 1;
                if ((this._prefix[m] ?? 0) > s) { ans = m; r = m; } else { l = m + 1; }
            }
            let start = Math.max(0, ans - 1 - pad);
            const endPos = s + this.viewMain();
            let end = ans;
            while (end < n && (this._prefix[end] ?? 0) < endPos) end++;
            return { start, end: Math.min(n, end + pad) };
        }

        const stride = Math.max(1, this._itemMainSize + this.spacing); // 防模板主轴尺寸为 0 时除零
        const first = Math.floor(Math.max(0, s - this.paddingTop) / stride) * this.cols();
        const visible = (Math.ceil(this.viewMain() / stride) + 1) * this.cols();
        return { start: Math.max(0, first - pad), end: Math.min(n, first + visible + pad) };
    }

    /** 核心：滚动 diff 旋转槽位，只重绑差额节点（references/01 §5）。 */
    private updateWindow(force: boolean): void {
        if (this._totalCount <= 0 || this._slots.length === 0) return;
        const range = this.calcRange();
        const newFirst = Math.min(range.start, Math.max(0, this._totalCount - this._slots.length));
        if (!force && newFirst === this._firstIndex) return;

        const diff = newFirst - this._firstIndex;
        if (force || Math.abs(diff) >= this._slots.length) {
            this._firstIndex = newFirst;
            for (let i = 0; i < this._slots.length; i++) this.bindSlot(i, newFirst + i);
            return;
        }

        if (diff > 0) {
            // 向尾部滚：头部 diff 个槽旋转到尾部，只重绑新露出的数据
            const moved = this._slots.splice(0, diff);
            this._slots.push(...moved);
            this._firstIndex = newFirst;
            for (let i = this._slots.length - diff; i < this._slots.length; i++) this.bindSlot(i, newFirst + i);
        } else {
            const abs = -diff;
            const moved = this._slots.splice(this._slots.length - abs, abs);
            this._slots.unshift(...moved);
            this._firstIndex = newFirst;
            for (let i = 0; i < abs; i++) this.bindSlot(i, newFirst + i);
        }
    }

    // ---------------- 绑定 / 回收 ----------------

    private bindSlot(slotIdx: number, index: number): void {
        const slot = this._slots[slotIdx];
        if (index < 0 || index >= this._totalCount) { this.recycleSlot(slot); return; }

        const type = this.typeOf(index);
        if (slot.node && slot.type !== type) {
            this.putNode(slot.node, slot.type);
            slot.node = null;
        }
        if (!slot.node) slot.node = this.newNode(type);

        const node = slot.node;
        slot.type = type;
        slot.index = index;

        const uit = node.getComponent(UITransform)!;
        // 先激活：Label/RichText 只有 enabledInHierarchy 才立即排版（不等高测量的前提）
        node.active = true;

        const mainSize = this.itemMainSize(index);
        if (this._vertical) uit.height = mainSize; else uit.width = mainSize;

        this.applyItemPosition(node, uit, index, mainSize);
        (node as any).__vlIndex = index; // 生产建议：用挂在节点上的小组件存 dataIndex，比挂任意属性更稳

        this.renderItemFn?.(node, index);

        if (this.isDynamic()) {
            const actual = this._vertical ? uit.height : uit.width;
            if (Math.abs(actual - (this._sizes[index] ?? 0)) > MEASURE_TOL) {
                this.setItemSize(index, actual);
            }
        }
    }

    private applyItemPosition(node: Node, uit: UITransform, index: number, mainSize: number): void {
        const ct = this.contentTf();
        const start = this.itemStart(index);
        if (this._vertical) {
            const topInLocal = (1 - ct.anchorY) * ct.height;
            const y = topInLocal - start - mainSize * (1 - uit.anchorY);
            const col = this.cols() > 1 ? index % this.cols() : 0;
            const centerX = (0.5 - ct.anchorX) * ct.width;
            const x = centerX + (col - (this.cols() - 1) / 2) * (this._itemCrossSize + this.gridSpacing);
            node.setPosition(this.px(x), this.px(y));
        } else {
            const leftInLocal = -ct.anchorX * ct.width;
            const x = leftInLocal + start + mainSize * uit.anchorX;
            const row = this.cols() > 1 ? index % this.cols() : 0;
            const centerY = (0.5 - ct.anchorY) * ct.height;
            const y = centerY - (row - (this.cols() - 1) / 2) * (this._itemCrossSize + this.gridSpacing);
            node.setPosition(this.px(x), this.px(y));
        }
    }

    private px(v: number): number { return this.pixelAlign ? Math.round(v) : v; }

    private recycleSlot(slot: ItemSlot): void {
        if (slot.node) { this.putNode(slot.node, slot.type); slot.node = null; }
        slot.type = -1;
        slot.index = -1;
    }

    // ---------------- 对象池 ----------------

    private newNode(type: number): Node {
        const pool = this._pools[type] || (this._pools[type] = []);
        let node = pool.pop();
        if (!node) {
            const prefab = this.itemPrefabs.length > 0 ? this.itemPrefabs[type] : this.itemPrefab;
            if (!prefab) {
                console.error(`[VirtualListView] 缺少类型 ${type} 的模板 Prefab`);
                node = new Node('vlFallback');
                node.addComponent(UITransform); // 代码建的 Node 不自动挂 UITransform，防后续测量空引用
            } else {
                node = instantiate(prefab);
            }
            // 点击在创建时绑一次，回调读 dataIndex——不要在每次绑定时 on/off
            node.on(Node.EventType.TOUCH_START, this._onItemTouchStart, this);
            node.on(Node.EventType.TOUCH_END, this._onItemTouchEnd, this);
        }
        node.parent = this._content;
        node.setScale(1, 1, 1);
        return node;
    }

    private putNode(node: Node, type: number): void {
        // references/02 §1 清理清单：引擎层重置 + 业务回调
        node.active = false;              // inactive 子树会被整体跳过（即回收时停渲染、省 CPU 的依据）
        node.removeFromParent();
        node.setScale(1, 1, 1);
        this.onRecycleFn?.(node);         // 停 tween / 撤异步 / 清定时器由业务负责
        const pool = this._pools[type] || (this._pools[type] = []);
        pool.push(node);
    }

    // ---------------- 点击 ----------------

    private _onItemTouchStart(e: EventTouch): void {
        const loc = e.getUILocation();
        this._clickStart.set(loc.x, loc.y);
    }

    private _onItemTouchEnd(e: EventTouch): void {
        if (!this.onItemClickFn) return;
        const loc = e.getUILocation();
        const dx = loc.x - this._clickStart.x;
        const dy = loc.y - this._clickStart.y;
        if (dx * dx + dy * dy > CLICK_SLOP * CLICK_SLOP) return; // 滚动误触过滤
        const node = e.target as Node | null;
        if (node && node.isValid) this.onItemClickFn(node, (node as any).__vlIndex);
    }
}
