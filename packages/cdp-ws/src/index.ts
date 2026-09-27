/**
 * @tw/cdp-ws 公共入口（docs/implement-plan/p3/01 §7 导出面）。
 *
 * P3 阶段逐步扩面：transport（CdpWsClient / discoverWebSocketUrl / 错误家族）→
 * 会话原语（CdpPageSession）。实现 CdpLikeClient（@tw/dom-snapshot protocol.ts）
 * 与架构 §4 CdpTransport 的 ws 形态——零 workspace 运行时依赖，契约由
 * test/contract.test.ts 的类型断言锁定。
 */
/** 脚手架占位导出（3.1 起被真实导出面替换） */
export const CDP_WS_SCAFFOLD = true;
