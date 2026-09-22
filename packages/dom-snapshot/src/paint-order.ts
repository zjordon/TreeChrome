/**
 * 绘制顺序过滤 —— Python dom-snapshot paint_order.py 的忠实移植。
 *
 * 维护一个"已被遮挡区域"的矩形合集，从最高 paintOrder（前景）到最低（背景）
 * 依次判定每个元素是否被完全覆盖。
 *
 * Rect -- 轴对齐包围盒 (AABB)
 * RectUnionPure -- 矩形并集，用几何差集维持不相交不变量
 * PaintOrderRemover -- 按绘制顺序遍历简化树，标记被遮挡节点
 */
import type { SimplifiedNode } from "./types.js";

/** 轴对齐矩形，(x1,y1) 左下角，(x2,y2) 右上角（Python frozen dataclass）。 */
export class Rect {
  constructor(
    public readonly x1: number,
    public readonly y1: number,
    public readonly x2: number,
    public readonly y2: number,
  ) {}

  area(): number {
    return (this.x2 - this.x1) * (this.y2 - this.y1);
  }

  intersects(other: Rect): boolean {
    return !(
      this.x2 <= other.x1 ||
      other.x2 <= this.x1 ||
      this.y2 <= other.y1 ||
      other.y2 <= this.y1
    );
  }

  contains(other: Rect): boolean {
    return this.x1 <= other.x1 && this.y1 <= other.y1 && this.x2 >= other.x2 && this.y2 >= other.y2;
  }
}

/**
 * 维护一组互不相交的矩形，表示已被遮挡的屏幕区域总和。
 *
 * 安全上限 MAX_RECTS 防止复杂页面中矩形碎片的指数爆炸。达到上限后 add()
 * 保守返回 false（不再添加新矩形），contains() 可能漏判被遮挡元素，
 * 但不会错误移除可见元素。
 */
export class RectUnionPure {
  private static readonly MAX_RECTS = 5000;
  private readonly rects: Rect[] = [];

  /** 计算差集 a \ b，返回最多 4 个子矩形。前提：a 与 b 相交（四切片法）。 */
  private splitDiff(a: Rect, b: Rect): Rect[] {
    const parts: Rect[] = [];
    if (a.y1 < b.y1) parts.push(new Rect(a.x1, a.y1, a.x2, b.y1));
    if (b.y2 < a.y2) parts.push(new Rect(a.x1, b.y2, a.x2, a.y2));

    const yLo = Math.max(a.y1, b.y1);
    const yHi = Math.min(a.y2, b.y2);
    if (a.x1 < b.x1) parts.push(new Rect(a.x1, yLo, b.x1, yHi));
    if (b.x2 < a.x2) parts.push(new Rect(b.x2, yLo, a.x2, yHi));
    return parts;
  }

  /** 判定矩形 r 是否被当前并集完全覆盖。栈消减法。 */
  contains(r: Rect): boolean {
    if (this.rects.length === 0) return false;
    let stack: Rect[] = [r];
    for (const s of this.rects) {
      const newStack: Rect[] = [];
      for (const piece of stack) {
        if (s.contains(piece)) continue;
        if (piece.intersects(s)) {
          for (const p of this.splitDiff(piece, s)) newStack.push(p);
        } else {
          newStack.push(piece);
        }
      }
      if (newStack.length === 0) return true;
      stack = newStack;
    }
    return false;
  }

  /** 将矩形 r 添加到并集（只添加未被覆盖的部分）。返回并集是否增长。 */
  add(r: Rect): boolean {
    if (this.rects.length >= RectUnionPure.MAX_RECTS) return false;
    if (this.contains(r)) return false;

    let pending: Rect[] = [r];
    for (const s of this.rects) {
      const newPending: Rect[] = [];
      for (const piece of pending) {
        if (piece.intersects(s)) {
          for (const p of this.splitDiff(piece, s)) newPending.push(p);
        } else {
          newPending.push(piece);
        }
      }
      pending = newPending;
    }
    for (const p of pending) this.rects.push(p);
    return true;
  }
}

/** 基于绘制顺序判定哪些节点被前景元素完全遮挡。 */
export class PaintOrderRemover {
  constructor(private readonly root: SimplifiedNode) {}

  /** 遍历简化树，按 paintOrder 从前景到背景判定遮挡关系。 */
  calculatePaintOrder(): void {
    const allNodesWithPaintOrder: SimplifiedNode[] = [];
    const collect = (node: SimplifiedNode): void => {
      const snap = node.originalNode.snapshotNode;
      if (snap && snap.paint_order !== null && snap.bounds !== null) {
        allNodesWithPaintOrder.push(node);
      }
      for (const child of node.children) collect(child);
    };
    collect(this.root);
    if (allNodesWithPaintOrder.length === 0) return;

    const grouped = new Map<number, SimplifiedNode[]>();
    for (const node of allNodesWithPaintOrder) {
      const po = node.originalNode.snapshotNode?.paint_order;
      if (po === null || po === undefined) continue;
      const arr = grouped.get(po);
      if (arr) arr.push(node);
      else grouped.set(po, [node]);
    }

    const rectUnion = new RectUnionPure();

    // sorted(grouped.items(), key=-paint_order)：前景（高 paintOrder）先处理
    const orders = [...grouped.keys()].sort((a, b) => b - a);
    for (const order of orders) {
      const nodes = grouped.get(order);
      if (!nodes) continue;
      const rectsToAdd: Rect[] = [];

      for (const node of nodes) {
        const snap = node.originalNode.snapshotNode;
        if (!snap?.bounds) continue;

        const b = snap.bounds;
        const rect = new Rect(b.x, b.y, b.x + b.width, b.y + b.height);

        if (rectUnion.contains(rect)) {
          node.ignoredByPaintOrder = true;
          // 阶段4：同步回填到 original_node —— selector_map 存的是 original_node，
          // rerun 侧 _is_actionable 才能直接查静态遮挡（L1）
          node.originalNode.ignoredByPaintOrder = true;
        }

        // 透明或低不透明度的元素不会遮挡下方内容
        const styles = snap.computed_styles;
        if (styles) {
          const bg = styles["background-color"] ?? "rgba(0, 0, 0, 0)";
          if (bg === "rgba(0, 0, 0, 0)") continue;
          // parseFloat 与 Python float() 在 Chrome 规范化十进制值上解析域一致；
          // 垃圾值 NaN < 0.8 为 false，与 Python except 回退 1.0 后不跳过的结果一致
          const opacity = parseFloat(styles.opacity ?? "1");
          if (opacity < 0.8) continue;
        }

        rectsToAdd.push(rect);
      }

      for (const rect of rectsToAdd) rectUnion.add(rect);
    }
  }
}
