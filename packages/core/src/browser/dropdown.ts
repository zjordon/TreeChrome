// 下拉族 25 方法（session.py :4344-5014）：native select 读写（懒加载 G11 重试/
// 回退点击）/ ARIA / custom class / combobox / 子树搜索 / 开态 discover 全链。
// JS 常量在 dropdown-js.ts（batch2b.json 逐字节锚定）。CDP/JS 异常上抛（handler
// 层友好包装）；Python flow（真实 click/Escape 的展开→读/写→收起）在此层内聚。

import {
  ARIA_OPTIONS_JS,
  COMBOBOX_LISTBOX_ID_JS,
  COMBOBOX_OPTIONS_JS,
  CUSTOM_CLASS_OPTIONS_JS,
  CUSTOM_FIND_OPTION_JS,
  CUSTOM_LISTBOX_DISCOVER_JS,
  CUSTOM_OPEN_OPTIONS_JS,
  CUSTOM_SCROLL_CAP,
  EFFECTIVE_CLICK_TARGET_JS,
  SCROLL_LISTBOX_JS,
  SELECT_OPTION_CLICK_FALLBACK_JS,
  SELECT_OPTION_JS,
  SELECT_OPTION_MULTI_JS,
  SET_ARIA_JS,
  SET_COMBOBOX_OPTION_JS,
  SET_CUSTOM_JS,
  SUBTREE_LOCATE_JS,
  SUBTREE_SEARCH_JS,
} from "./dropdown-js.js";
import { clickElement } from "./element-pointer.js";
import { sendKeys } from "./keyboard.js";
import type { SessionInternals } from "./transport.js";

/** 下拉选项（JS 探针产物形态：{value, text, selected}） */
export interface DropdownOption {
  value?: string;
  text?: string;
  selected?: boolean;
}

/** setter 族统一结果形态（D2：与 set_select_option 同形，action 层零分型分支） */
export interface DropdownSetterResult {
  success: boolean;
  message?: string;
  value?: string;
  values?: string[];
  missed?: string[];
  selectionReverted?: boolean;
  targetOption?: { index?: number };
  availableOptions?: DropdownOption[];
  error?: string;
  /** 写 dispatcher 附加的类型通道（'aria'|'custom'|'child-depth-N'|null） */
  source?: string | null;
}

/** 读 dispatcher 结果：{options, source}（source null = 非任何已知下拉类型） */
export interface DropdownDispatchResult {
  options: DropdownOption[];
  source: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asResult = (v: unknown): DropdownSetterResult =>
  isRecord(v) ? (v as unknown as DropdownSetterResult) : { success: false };
const asOptions = (v: unknown): DropdownOption[] | null =>
  Array.isArray(v) ? (v as DropdownOption[]) : null;

/** resolveNode → objectId（家族内三处共用形态） */
async function resolveObjectId(s: SessionInternals, backendNodeId: number): Promise<string> {
  const resolve = await s.send<Record<string, unknown>>("DOM.resolveNode", { backendNodeId });
  const object = isRecord(resolve.object) ? resolve.object : {};
  const objectId = object.objectId;
  if (typeof objectId !== "string") {
    throw new Error("dropdown: resolveNode 未返回 objectId");
  }
  return objectId;
}

/** callFunctionOn → result.value（returnByValue） */
async function callFn(
  s: SessionInternals,
  objectId: string,
  functionDeclaration: string,
  args?: Array<Record<string, unknown>>,
  returnByValue = true,
): Promise<unknown> {
  const result = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    ...(args === undefined ? {} : { arguments: args }),
    returnByValue,
  });
  const inner = isRecord(result.result) ? result.result : {};
  return inner.value;
}

/** :4344-4381 native <select> 选项枚举（resolveNode+callFunctionOn 作用域限定） */
export async function fetchSelectOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownOption[]> {
  const objectId = await resolveObjectId(s, backendNodeId);
  const value = await callFn(
    s,
    objectId,
    "function() {\n" +
      "    return Array.from(this.options).map(function(o) {\n" +
      "        return {\n" +
      "            value: o.value,\n" +
      "            text: (o.textContent || '').trim(),\n" +
      "            selected: o.selected,\n" +
      "        };\n" +
      "    });\n" +
      "}",
  );
  return asOptions(value) ?? [];
}

/**
 * :4382-4428 callFunctionOn + G11 空选项懒加载重试（单/多选共用）：select 有 option
 * 但全空（text 与 value 都空白）→ focus + sleep 1.0s + 重跑一次。返回该 JS 的 dict。
 */
async function lazySelectCall(
  s: SessionInternals,
  objectId: string,
  functionDeclaration: string,
  args: Array<Record<string, unknown>>,
): Promise<DropdownSetterResult> {
  const run = async (): Promise<DropdownSetterResult> =>
    asResult(await callFn(s, objectId, functionDeclaration, args));
  let selection = await run();
  const avail = selection.availableOptions ?? [];
  const allEmpty =
    !selection.success &&
    Array.isArray(avail) &&
    avail.length > 0 &&
    avail.every((o) => !(o.text ?? "").trim() && !(o.value ?? "").trim());
  if (allEmpty) {
    await callFn(s, objectId, "function(){ try{ this.focus(); } catch(e){ } }");
    await s.sleep(1000);
    selection = await run();
  }
  return selection;
}

/** :4429-4476 native 单选：三连写 + input/change/blur + 回读验证；回退点击兜底 */
export async function setSelectOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  const objectId = await resolveObjectId(s, backendNodeId);
  const selection = await lazySelectCall(s, objectId, SELECT_OPTION_JS, [{ value }]);
  if (selection.selectionReverted) {
    const optionIndex = selection.targetOption?.index ?? 0;
    const fb = asResult(
      await callFn(s, objectId, SELECT_OPTION_CLICK_FALLBACK_JS, [{ value: optionIndex }]),
    );
    if (fb.success) {
      return {
        success: true,
        message: fb.message,
        value: typeof fb.value === "string" ? fb.value : value,
      };
    }
    // 回退也失败 → 原样返回结构化 error（携带 availableOptions 供 action 层回显）
  }
  return selection;
}

/** :4477-4561 native 多选整组设置（<select multiple>，issue #192） */
export async function setSelectOptionMulti(
  s: SessionInternals,
  backendNodeId: number,
  values: string[],
): Promise<DropdownSetterResult> {
  const objectId = await resolveObjectId(s, backendNodeId);
  return lazySelectCall(s, objectId, SELECT_OPTION_MULTI_JS, [{ value: values }]);
}

/** :4530-4561 形态的 resolveNode+callFunctionOn(setter JS, value) 样板 */
async function callSetterOnNode(
  s: SessionInternals,
  backendNodeId: number,
  functionDeclaration: string,
  value: string,
): Promise<DropdownSetterResult> {
  const objectId = await resolveObjectId(s, backendNodeId);
  return asResult(await callFn(s, objectId, functionDeclaration, [{ value }]));
}

/** :4859 之前 ARIA option 写入（_fetch_aria_options 的写侧对应） */
export async function setAriaOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  return callSetterOnNode(s, backendNodeId, SET_ARIA_JS, value);
}

/** custom class option 写入（_fetch_custom_class_options 的写侧对应） */
export async function setCustomOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  return callSetterOnNode(s, backendNodeId, SET_CUSTOM_JS, value);
}

/** :4591-4600 ARIA 选项枚举（null = 非 aria 形态，dispatcher 试下一型） */
async function fetchAriaOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownOption[] | null> {
  const objectId = await resolveObjectId(s, backendNodeId);
  return asOptions(await callFn(s, objectId, ARIA_OPTIONS_JS));
}

/** :4601-4627 custom class 选项枚举（null = 非 custom 形态） */
async function fetchCustomClassOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownOption[] | null> {
  const objectId = await resolveObjectId(s, backendNodeId);
  return asOptions(await callFn(s, objectId, CUSTOM_CLASS_OPTIONS_JS));
}

/** :4666-4680 强制收起 combobox（Escape + blur；残留展开的遮罩会挡后续 click） */
async function collapseCombobox(s: SessionInternals, objectId: string | null): Promise<void> {
  try {
    await sendKeys(s, "Escape");
    if (objectId !== null) {
      await callFn(s, objectId, "function(){ try{ this.blur(); } catch(e){ } }");
    }
  } catch (e) {
    s.log(`combobox collapse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** :4681-4698 自定义下拉是否仍展开（Semi .semi-popover-wrapper-show 或可见 listbox） */
async function customDropdownStillOpen(s: SessionInternals): Promise<boolean> {
  try {
    const r = await s.send<Record<string, unknown>>("Runtime.evaluate", {
      expression:
        "!!document.querySelector('.semi-popover-wrapper-show') " +
        "|| Array.from(document.querySelectorAll('[role=\"listbox\"]'))" +
        ".some(function(lb){ var r=lb.getBoundingClientRect(); " +
        "return r.width>0 && r.height>0; })",
      returnByValue: true,
    });
    const inner = isRecord(r.result) ? r.result : {};
    return inner.value === true;
  } catch (e) {
    s.log(`custom dropdown still-open check failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * :4699-4712 收起自定义下拉：先 Escape（多数框架）；仍开着则真实 click 触发器
 * toggle 收起（Semi 只认 trusted outside / 再点触发器）。best-effort。
 */
async function collapseCustomDropdown(
  s: SessionInternals,
  triggerBackendId: number,
): Promise<void> {
  try {
    await sendKeys(s, "Escape");
  } catch (e) {
    s.log(`custom dropdown Escape failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (await customDropdownStillOpen(s)) {
    try {
      await clickElement(s, triggerBackendId);
    } catch (e) {
      s.log(`custom dropdown toggle-close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * :4713-4749 展开 combobox（真实 click）→ sleep 0.5 → 读 aria-controls listbox
 * （getElementById，React Portal 挂 body 也能找到）→ finally 强制收起。listbox
 * 未找到抛 Error。
 */
export async function expandAndFetchComboboxOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownOption[]> {
  await clickElement(s, backendNodeId);
  await s.sleep(500);
  let objectId: string | null = null;
  try {
    objectId = await resolveObjectId(s, backendNodeId);
    const raw = await callFn(s, objectId, COMBOBOX_OPTIONS_JS);
    const payload = isRecord(raw) ? raw : {};
    if (payload.listboxFound !== true) {
      throw new Error(`combobox listbox not found: ${String(payload.error ?? "")}`);
    }
    return asOptions(payload.options) ?? [];
  } finally {
    await collapseCombobox(s, objectId);
  }
}

/** :4750-4787 combobox 写：展开 → 定位 listbox objectId → 写 → finally 收起 */
export async function setComboboxOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  await clickElement(s, backendNodeId);
  await s.sleep(500);
  let comboObjectId: string | null = null;
  try {
    comboObjectId = await resolveObjectId(s, backendNodeId);
    const lb = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId: comboObjectId,
      functionDeclaration: COMBOBOX_LISTBOX_ID_JS,
      returnByValue: false,
    });
    const lbResult = isRecord(lb.result) ? lb.result : {};
    const listboxObjectId = lbResult.objectId;
    if (typeof listboxObjectId !== "string" || listboxObjectId === "") {
      return {
        success: false,
        error: "combobox listbox not found (no aria-controls/aria-owns target)",
        availableOptions: [],
      };
    }
    return asResult(await callFn(s, listboxObjectId, SET_COMBOBOX_OPTION_JS, [{ value }]));
  } finally {
    await collapseCombobox(s, comboObjectId);
  }
}

/** :4788-4820 触发器 4 层内最外层 select-ish 祖先（真正持有展开 handler 的目标） */
async function effectiveClickBid(
  s: SessionInternals,
  triggerObjectId: string,
  fallbackBid: number,
): Promise<number> {
  try {
    const r = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId: triggerObjectId,
      functionDeclaration: EFFECTIVE_CLICK_TARGET_JS,
      returnByValue: false,
    });
    const inner = isRecord(r.result) ? r.result : {};
    const oid = inner.objectId;
    if (typeof oid !== "string" || oid === "") return fallbackBid;
    return (await backendIdOfObject(s, oid)) ?? fallbackBid;
  } catch (e) {
    s.log(`effective click target resolve failed: ${e instanceof Error ? e.message : String(e)}`);
    return fallbackBid;
  }
}

/**
 * :4821-4857 展开自定义下拉并发现 option list：先点 effective target，未发现再点
 * 原触发器（同一目标只点一次）。返回 [listboxObjectId, triggerObjectId]。
 */
async function openAndDiscoverListbox(
  s: SessionInternals,
  backendNodeId: number,
): Promise<[string | null, string]> {
  const triggerObjectId = await resolveObjectId(s, backendNodeId);
  const clickBid = await effectiveClickBid(s, triggerObjectId, backendNodeId);
  const attempts = clickBid === backendNodeId ? [clickBid] : [clickBid, backendNodeId];
  let listboxObjectId: string | null = null;
  for (const bid of attempts) {
    await clickElement(s, bid);
    await s.sleep(500);
    const lb = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId: triggerObjectId,
      functionDeclaration: CUSTOM_LISTBOX_DISCOVER_JS,
      returnByValue: false,
    });
    const inner = isRecord(lb.result) ? lb.result : {};
    const oid = inner.objectId;
    if (typeof oid === "string" && oid !== "") {
      listboxObjectId = oid;
      break;
    }
  }
  return [listboxObjectId, triggerObjectId];
}

/** 在发现的 list 节点上读 options */
async function readCustomOptions(
  s: SessionInternals,
  listboxObjectId: string,
): Promise<DropdownOption[]> {
  return asOptions(await callFn(s, listboxObjectId, CUSTOM_OPEN_OPTIONS_JS)) ?? [];
}

/** remote objectId → backendNodeId（DOM.describeNode）；best-effort null */
async function backendIdOfObject(s: SessionInternals, objectId: string): Promise<number | null> {
  try {
    const desc = await s.send<Record<string, unknown>>("DOM.describeNode", { objectId });
    const node = isRecord(desc.node) ? desc.node : {};
    const bid = node.backendNodeId;
    return typeof bid === "number" ? bid : null;
  } catch (e) {
    s.log(`backend_id_of_object failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** :4923-4935 滚发现的 listbox 下一页；返回是否真滚了（不可滚/到底/异常 false） */
async function scrollListbox(s: SessionInternals, listboxObjectId: string): Promise<boolean> {
  try {
    const v = await callFn(s, listboxObjectId, SCROLL_LISTBOX_JS);
    return v === true;
  } catch (e) {
    s.log(`listbox scroll failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** :4898-4922 list 上找匹配 option（精确→包含），含虚拟化 scroll-until-found */
async function findOptionObjectId(
  s: SessionInternals,
  listboxObjectId: string,
  value: string,
): Promise<string | null> {
  for (let i = 0; i < CUSTOM_SCROLL_CAP + 1; i++) {
    const r = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId: listboxObjectId,
      functionDeclaration: CUSTOM_FIND_OPTION_JS,
      arguments: [{ value }],
      returnByValue: false,
    });
    const inner = isRecord(r.result) ? r.result : {};
    const oid = inner.objectId;
    if (typeof oid === "string" && oid !== "") return oid;
    if (!(await scrollListbox(s, listboxObjectId))) return null;
    await s.sleep(120);
  }
  return null;
}

/** :4858-4897 开 + 发现 + 真实 click option + 收起（虚拟化滚动内含） */
export async function setCustomDropdownOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  try {
    const [listboxObjectId] = await openAndDiscoverListbox(s, backendNodeId);
    if (listboxObjectId === null) {
      return {
        success: false,
        error: "custom dropdown listbox not found after opening",
        availableOptions: [],
      };
    }
    const optionObjectId = await findOptionObjectId(s, listboxObjectId, value);
    if (optionObjectId === null) {
      return {
        success: false,
        error: `Option with text or value '${value}' not found in custom dropdown`,
        availableOptions: await readCustomOptions(s, listboxObjectId),
      };
    }
    const optionBid = await backendIdOfObject(s, optionObjectId);
    if (optionBid === null) {
      return {
        success: false,
        error: "custom dropdown option could not be resolved",
        availableOptions: await readCustomOptions(s, listboxObjectId),
      };
    }
    await clickElement(s, optionBid);
    await s.sleep(300);
    // 真实 click 命中匹配 option 即视为选中（硬 readback 会因框架差异误报）
    return { success: true, message: `Selected option: ${value}`, value };
  } finally {
    await collapseCustomDropdown(s, backendNodeId);
  }
}

/** :4858 展开读流：开 + 发现 + 读，finally 收起；listbox 未发现抛 Error */
export async function expandAndFetchCustomOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownOption[]> {
  try {
    const [listboxObjectId] = await openAndDiscoverListbox(s, backendNodeId);
    if (listboxObjectId === null) {
      throw new Error("custom dropdown listbox not found after opening");
    }
    return await readCustomOptions(s, listboxObjectId);
  } finally {
    await collapseCustomDropdown(s, backendNodeId);
  }
}

/** :4944-5014 BFS 子树（max_depth 层）找下拉形子代并原地读（JS 侧递归） */
export async function searchChildrenForDropdowns(
  s: SessionInternals,
  backendNodeId: number,
  maxDepth = 4,
): Promise<DropdownDispatchResult> {
  const objectId = await resolveObjectId(s, backendNodeId);
  const value = await callFn(s, objectId, SUBTREE_SEARCH_JS, [{ value: maxDepth }]);
  const payload = isRecord(value) ? value : {};
  const options = asOptions(payload.options) ?? [];
  const source = typeof payload.source === "string" ? payload.source : null;
  return { options, source };
}

/** 读 dispatcher：ARIA → custom class → 子树搜索，首个命中胜出 */
export async function fetchDropdownOptions(
  s: SessionInternals,
  backendNodeId: number,
): Promise<DropdownDispatchResult> {
  const aria = await fetchAriaOptions(s, backendNodeId);
  if (aria !== null) return { options: aria, source: "aria" };
  const custom = await fetchCustomClassOptions(s, backendNodeId);
  if (custom !== null) return { options: custom, source: "custom" };
  const found = await searchChildrenForDropdowns(s, backendNodeId);
  if (found.options.length > 0) {
    return { options: found.options, source: found.source };
  }
  return { options: [], source: null };
}

/** 子代 setter 直调（objectId 形态——_SUBTREE_LOCATE_JS 产物） */
async function callSetterOnObject(
  s: SessionInternals,
  objectId: string,
  functionDeclaration: string,
  value: string,
): Promise<DropdownSetterResult> {
  return asResult(await callFn(s, objectId, functionDeclaration, [{ value }]));
}

/**
 * :4988-5014 定位子代下拉（BFS 返回 objectId+类型）并按类型调 aria/custom setter
 * （D5 两阶段编排：returnByValue 会剥离对象身份，locator 先取子代 RemoteObject）。
 * **上游潜在死代码（保真复刻）**：Python `payload.get("found")` 读的是 callFunctionOn
 * 的 result 外壳（returnByValue=False 下无 found 键，恒 falsy）→ 实际恒走
 * "vanished" 错误分支，其后的 setter 选择段不可达；TS 同构该可观测行为。
 */
async function setSubtreeOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  const parentObjectId = await resolveObjectId(s, backendNodeId);
  const located = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
    objectId: parentObjectId,
    functionDeclaration: SUBTREE_LOCATE_JS,
    arguments: [{ value: 4 }],
    returnByValue: false,
  });
  const inner = isRecord(located.result) ? located.result : {};
  const payload = isRecord(inner.value) ? (inner.value as Record<string, unknown>) : inner;
  if (payload.found !== true) {
    return { success: false, error: "subtree child dropdown vanished between read and write" };
  }
  const setter = payload.type === "aria" ? SET_ARIA_JS : SET_CUSTOM_JS;
  // CDP-shape：returnByValue=false 下嵌套节点 objectId 兼容顶层与 node.objectId 两种
  const node = isRecord(payload.node) ? payload.node : null;
  const childObjectId =
    (typeof payload.objectId === "string" ? payload.objectId : null) ??
    (node !== null && typeof node.objectId === "string" ? node.objectId : null);
  if (childObjectId === null) {
    return { success: false, error: "could not resolve subtree child objectId" };
  }
  return callSetterOnObject(s, childObjectId, setter, value);
}

/**
 * :4562-4590 写 dispatcher：复用读 dispatcher 判型（同一份 JS，读写零漂移——D1），
 * 按 source 路由；source null = 非已知类型（action 层据此走开态 fallback）。
 */
export async function setDropdownOption(
  s: SessionInternals,
  backendNodeId: number,
  value: string,
): Promise<DropdownSetterResult> {
  const classified = await fetchDropdownOptions(s, backendNodeId);
  const source = classified.source;
  if (source === "aria") {
    const result = await setAriaOption(s, backendNodeId, value);
    result.source = source;
    return result;
  }
  if (source === "custom") {
    const result = await setCustomOption(s, backendNodeId, value);
    result.source = source;
    return result;
  }
  if (source?.startsWith("child-depth-")) {
    const result = await setSubtreeOption(s, backendNodeId, value);
    result.source = source;
    return result;
  }
  return { success: false, source: null, error: "not a recognized dropdown" };
}
