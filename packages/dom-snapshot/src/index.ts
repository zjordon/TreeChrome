/**
 * @tw/dom-snapshot 公共入口。
 *
 * 已移植：models（types.ts）、协议（protocol.ts）、采集融合（collector.ts，P1.2）、
 * CDP 批调用（cdp-batch.ts）、交互检测（interactive.ts）、绘制顺序遮挡
 * （paint-order.ts）、五步序列化管线（serializer.ts，P1.3）、组合入口
 * buildDomState / EMPTY_DOM_STATE（collector.ts，P1.5）。
 */
export * from "./cdp-batch.js";
export * from "./collector.js";
export * from "./interactive.js";
export * from "./paint-order.js";
export * from "./protocol.js";
export * from "./serializer.js";
export * from "./types.js";
