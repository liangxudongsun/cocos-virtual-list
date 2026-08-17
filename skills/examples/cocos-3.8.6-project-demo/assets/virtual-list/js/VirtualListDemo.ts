import {
    _decorator, Component, Node, ScrollView, UITransform, Mask, Graphics, Label,
    Button, Color, Vec3, Size, Canvas, Layers, view, HorizontalTextAlignment,
} from 'cc';
const { ccclass } = _decorator;
import { VirtualList } from '../components/VirtualList';

/**
 * 虚拟列表演示脚本（纯代码搭建，无需任何手动编辑器配置）
 *
 * 使用方式：
 *  1. 新建场景，添加 Canvas；
 *  2. 在 Canvas 下新建一个空节点，挂上本脚本；
 *  3. 运行，即可看到 10 万条数据的虚拟列表：滚动流畅、节点总量恒定。
 *
 * 注意：脚本宿主节点不需要挂任何组件——ScrollView、view、content、item 模板、
 * 统计条、按钮等整套 UI 都会在运行时自动创建。
 *
 * 演示要点：
 *  - 自动适配宿主节点尺寸：把本脚本挂到任意带 UITransform 的容器节点上，
 *    ScrollView 就铺满该容器、Mask 正好裁剪容器区域（容器 800x600 就只在
 *    800x600 内显示列表，一屏能放多少个由容器高度决定）；宿主节点没有
 *    UITransform（纯空节点）时退回全屏（Canvas 设计分辨率）；
 *  - 数据量 10 万条，但存活的 item 节点始终只有几十个（视口数 + 缓冲），
 *    顶部实时统计「存活节点 / 累计创建 / 复用次数」，直观展示"虚拟化"效果；
 *  - 两个按钮演示 scrollToIndex：跳到底部、随机跳转。
 */
@ccclass('VirtualListDemo')
export class VirtualListDemo extends Component {

    // ---------- 演示参数（尺寸自适应设计分辨率，这里只留内容参数） ----------
    private static readonly LIST_ITEM_COUNT = 100000; // 数据总量
    private static readonly ITEM_H = 100;             // item 高（宽 = 容器宽）
    private static readonly GAP = 8;                  // item 间距
    private static readonly PADDING = 12;             // 上下内边距
    private static readonly BUFFER = 2;               // 缓冲行数（可视区外每侧各缓存 2 行，即前后各 2 个 item）

    // ---------- 运行时状态 ----------
    private _virtualList: VirtualList | null = null;
    private _statsLabel: Label | null = null;
    private _tmpColor: Color = new Color();
    private _viewW = 720;   // 自适应后的视口宽
    private _viewH = 1280;  // 自适应后的视口高

    /** 模拟数据（真实项目中通常懒加载：onItemRender 里按 index 现取/现算） */
    private _data: string[] = [];

    protected start (): void {
        this._buildDemo();
    }

    protected onDestroy (): void {
        this.unschedule(this._updateStats);
    }

    // ===================== UI 搭建 =====================

    private _buildDemo (): void {
        // 视口尺寸 = 宿主节点（挂脚本的容器）的 UITransform 尺寸；
        // 这样 ScrollView 正好铺在容器内、Mask 正好裁剪容器区域。
        // 宿主节点没有 UITransform（纯空节点）时退回 Canvas 设计分辨率（全屏列表）。
        const viewportSize = this._getViewportSize();
        this._viewW = viewportSize.width;
        this._viewH = viewportSize.height;

        this._generateData();

        // --- 1. ScrollView（全屏） ---
        const scrollNode = new Node('ScrollView');
        this._addToUI(scrollNode, this.node);
        scrollNode.setPosition(0, 0);
        const scrollTrans = scrollNode.addComponent(UITransform);
        scrollTrans.setContentSize(this._viewW, this._viewH);

        const scrollView = scrollNode.addComponent(ScrollView);
        scrollView.horizontal = false;
        scrollView.vertical = true;
        scrollView.elastic = false; // 关闭回弹，滚动干净利落

        // --- 2. view（显示区，带 Mask 裁剪——列表只在屏内显示） ---
        const viewNode = new Node('view');
        this._addToUI(viewNode, scrollNode);
        const viewTrans = viewNode.addComponent(UITransform);
        viewTrans.setContentSize(this._viewW, this._viewH);
        const mask = viewNode.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        // --- 3. content（滚动内容，anchor 左上角，坐标最直观） ---
        const contentNode = new Node('content');
        this._addToUI(contentNode, viewNode);
        const contentTrans = contentNode.addComponent(UITransform);
        contentTrans.setContentSize(this._viewW, this._viewH);
        contentTrans.setAnchorPoint(0, 1);

        // 绑定 ScrollView.content —— 必须的！ScrollView 的显示区（view）是
        // 根据 content 的父节点推导的，不绑定则 view 为 null，VirtualList 会初始化失败。
        scrollView.content = contentNode;

        // --- 4. item 模板（隐藏节点，作为克隆来源） ---
        const template = this._createItemTemplate(contentNode);

        // --- 5. 挂载虚拟列表组件 ---
        const vl = contentNode.addComponent(VirtualList);
        vl.scrollView = scrollView; // 显式指定（组件也支持自动向上查找）
        vl.itemTemplate = template;
        vl.itemSize = new Size(this._viewW, VirtualListDemo.ITEM_H);
        vl.gap = VirtualListDemo.GAP;
        vl.paddingTop = VirtualListDemo.PADDING;
        vl.paddingBottom = VirtualListDemo.PADDING;
        vl.buffer = VirtualListDemo.BUFFER;
        vl.onItemRender = (itemNode, index) => this._renderItem(itemNode, index);
        vl.onItemClick = (itemNode, index) => this._onItemClick(itemNode, index);
        vl.setItemCount(VirtualListDemo.LIST_ITEM_COUNT);
        this._virtualList = vl;

        // --- 6. 顶部统计条 ---
        this._createStatsBar();

        // --- 7. 底部按钮（跳转用立即模式：远距离跳转播动画会"闪"，直接到位最干净） ---
        this._createButton('btn-bottom', new Vec3(-115, -this._viewH / 2 + 64, 0), '跳到底部', () => {
            this._virtualList?.scrollToIndex(VirtualListDemo.LIST_ITEM_COUNT - 1);
        });
        this._createButton('btn-random', new Vec3(115, -this._viewH / 2 + 64, 0), '随机跳转', () => {
            const idx = Math.floor(Math.random() * VirtualListDemo.LIST_ITEM_COUNT);
            this._virtualList?.scrollToIndex(idx);
        });

        // --- 8. 定时刷新统计 ---
        this.schedule(this._updateStats, 0.15);
        this._updateStats();
    }

    /**
     * 获取列表视口尺寸，优先级：
     *  1. 宿主节点（挂本脚本的节点）的 UITransform 尺寸 —— 用户定义的容器区域；
     *  2. 向上查找 Canvas 的设计分辨率（宿主节点无 UITransform 时，全屏列表）；
     *  3. 可见屏幕尺寸（兜底）。
     */
    private _getViewportSize (): Size {
        const selfTrans = this.node.getComponent(UITransform);
        if (selfTrans && selfTrans.width > 0 && selfTrans.height > 0) {
            return selfTrans.contentSize;
        }
        let node: Node | null = this.node;
        while (node) {
            if (node.getComponent(Canvas)) {
                const tf = node.getComponent(UITransform);
                if (tf) return tf.contentSize;
            }
            node = node.parent;
        }
        const visible = view.getVisibleSize();
        return new Size(visible.width, visible.height);
    }

    /** 把新节点挂到 UI 树并设置 UI_2D 层（new Node() 默认是 DEFAULT 层，UI 应显式指定） */
    private _addToUI (node: Node, parent: Node): void {
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
    }

    /** 生成 10 万条模拟数据 */
    private _generateData (): void {
        this._data = new Array(VirtualListDemo.LIST_ITEM_COUNT);
        for (let i = 0; i < VirtualListDemo.LIST_ITEM_COUNT; i++) {
            this._data[i] = `玩家 ${i % 10000} 通关了关卡 ${(i * 7) % 50 + 1}，获得 ${(i * 13) % 999 + 1} 金币`;
        }
    }

    // ===================== item =====================

    /** 创建 item 模板节点（含背景 + 两行文本，active=false 只作克隆源） */
    private _createItemTemplate (parent: Node): Node {
        const node = new Node('itemTemplate');
        this._addToUI(node, parent);
        const trans = node.addComponent(UITransform);
        trans.setContentSize(this._viewW, VirtualListDemo.ITEM_H);

        // 背景：Graphics 画圆角矩形（真实项目可用图集 Sprite 以支持合批）
        const bg = node.addComponent(Graphics);
        bg.fillColor = new Color(240, 244, 250, 255);
        bg.roundRect(-this._viewW / 2 + 4, -VirtualListDemo.ITEM_H / 2 + 4,
            this._viewW - 8, VirtualListDemo.ITEM_H - 8, 12);
        bg.fill();

        // 第一行：序号
        this._createLabel(node, 'indexLabel', new Vec3(-this._viewW / 2 + 20, 24, 0), '0',
            32, new Color(30, 40, 60, 255), true, Label.HorizontalAlign.LEFT, true);

        // 第二行：模拟数据
        this._createLabel(node, 'descLabel', new Vec3(-this._viewW / 2 + 20, -24, 0), '',
            20, new Color(100, 110, 125, 255), false, Label.HorizontalAlign.LEFT, true);

        node.active = false; // 模板隐藏
        return node;
    }

    /** 渲染回调：item 进入可视区时绑定数据（注意：复用的节点也要重新绑定） */
    private _renderItem (itemNode: Node, index: number): void {
        // 背景色随 index 平滑变化（复用临时 Color，避免产生垃圾对象）
        // 注意：fromHSV 是 Color 的【实例】方法（不是静态方法）
        this._tmpColor.fromHSV((index * 37) % 360 / 360, 0.35, 0.97);
        const g = itemNode.getComponent(Graphics);
        if (g) {
            g.clear();
            g.fillColor = this._tmpColor;
            g.roundRect(-this._viewW / 2 + 4, -VirtualListDemo.ITEM_H / 2 + 4,
                this._viewW - 8, VirtualListDemo.ITEM_H - 8, 12);
            g.fill();
        }
        const indexLabel = itemNode.getChildByName('indexLabel')?.getComponent(Label);
        if (indexLabel) indexLabel.string = `#${index.toLocaleString()}`;

        const descLabel = itemNode.getChildByName('descLabel')?.getComponent(Label);
        if (descLabel) descLabel.string = this._data[index];
    }

    /** 点击回调演示：打印 index + 背景闪红 0.15s 后恢复（滚动经过时 onItemRender 会自动重绘成正常色） */
    private _onItemClick (itemNode: Node, index: number): void {
        console.log(`[VirtualListDemo] 点击了第 ${index} 条`);
        const g = itemNode.getComponent(Graphics);
        if (g) {
            g.clear();
            g.fillColor = new Color(255, 120, 120, 255);
            g.roundRect(-this._viewW / 2 + 4, -VirtualListDemo.ITEM_H / 2 + 4,
                this._viewW - 8, VirtualListDemo.ITEM_H - 8, 12);
            g.fill();
            this.scheduleOnce(() => {
                if (itemNode.isValid && itemNode.active) this._renderItem(itemNode, index);
            }, 0.15);
        }
    }

    // ===================== 统计 =====================

    private _createStatsBar (): void {
        const bar = new Node('statsBar');
        this._addToUI(bar, this.node);
        bar.setPosition(0, this._viewH / 2 - 80);

        const trans = bar.addComponent(UITransform);
        trans.setContentSize(this._viewW - 20, 130);

        const bg = bar.addComponent(Graphics);
        bg.fillColor = new Color(15, 20, 30, 210);
        bg.roundRect(-(this._viewW - 20) / 2, -65, this._viewW - 20, 130, 16);
        bg.fill();

        this._statsLabel = this._createLabel(bar, 'statsLabel', new Vec3(0, 0, 0), '',
            24, new Color(255, 255, 255, 255), true, Label.HorizontalAlign.CENTER);
    }

    private _updateStats (): void {
        if (!this._statsLabel || !this._virtualList) return;
        const vl = this._virtualList;
        this._statsLabel.string =
            `虚拟列表性能演示｜数据量 ${VirtualListDemo.LIST_ITEM_COUNT.toLocaleString()} 条\n` +
            `存活节点 ${vl.aliveCount}｜累计创建 ${vl.totalCreated}｜复用 ${vl.reusedCount.toLocaleString()} 次\n` +
            `10 万条数据只创建了几十个节点，这就是虚拟化的效果`;
    }

    // ===================== 工具 =====================

    private _createButton (
        name: string, pos: Vec3, text: string, onClick: () => void,
    ): void {
        const node = new Node(name);
        this._addToUI(node, this.node);
        node.setPosition(pos);

        const trans = node.addComponent(UITransform);
        trans.setContentSize(200, 64);

        const g = node.addComponent(Graphics);
        g.fillColor = new Color(52, 120, 246, 255);
        g.roundRect(-100, -32, 200, 64, 14);
        g.fill();

        const btn = node.addComponent(Button);
        btn.transition = Button.Transition.NONE;
        node.on(Button.EventType.CLICK, onClick, this);

        this._createLabel(node, 'label', new Vec3(0, 0, 0), text,
            26, new Color(255, 255, 255, 255), true, Label.HorizontalAlign.CENTER);
    }

    private _createLabel (
        parent: Node, name: string, pos: Vec3, text: string,
        fontSize: number, color: Color, bold: boolean, align: HorizontalTextAlignment,
        leftAlign = false,
    ): Label {
        const node = new Node(name);
        parent.addChild(node);
        node.setPosition(pos);
        const nodeTrans = node.addComponent(UITransform);
        nodeTrans.setContentSize(this._viewW - 80, 44);
        // 左对齐时把锚点设到左中，让文本紧贴 item 左缘
        if (leftAlign) nodeTrans.setAnchorPoint(0, 0.5);

        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 6;
        label.color = color;
        label.isBold = bold;
        label.horizontalAlign = align;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        return label;
    }
}
