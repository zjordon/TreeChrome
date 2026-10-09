// ProviderCardForm（m5/05 §1）：provider 卡表单（增/改）。校验：protocol 必选、
// name/baseUrl/apiKey/model 非空、baseUrl http(s):// 前缀、maxTokens 正整数、
// temperature 0-2。onTest 由宿主注入（SW 端点可达性探测）。

import type { ProviderCardDto } from "@tw/protocol";
import { useState } from "react";
import { Button, Field } from "./primitives.js";

/** 协议选项（锚 core LLMProtocol 联合——本包不依赖 core，字面量同步维护） */
export const PROTOCOL_OPTIONS = ["openai-completions", "anthropic-messages", "gemini"] as const;

export type ProtocolOption = (typeof PROTOCOL_OPTIONS)[number];

export interface CardFormState {
  name: string;
  protocol: ProtocolOption;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: string;
  temperature: string;
}

export function formStateOf(card?: ProviderCardDto): CardFormState {
  return {
    name: card?.name ?? "",
    protocol: card?.protocol ?? "openai-completions",
    baseUrl: card?.baseUrl ?? "",
    apiKey: card?.apiKey ?? "",
    model: card?.model ?? "",
    maxTokens: String(card?.maxTokens ?? 16384),
    temperature: card?.temperature !== undefined ? String(card.temperature) : "",
  };
}

export interface CardFormErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: string;
  temperature?: string;
}

/** 校验（导出供单测）：空值/形态面；通过返回空错集 */
export function validateCardForm(v: CardFormState): CardFormErrors {
  const errors: CardFormErrors = {};
  if (v.name.trim() === "") errors.name = "必填";
  if (v.baseUrl.trim() === "") errors.baseUrl = "必填";
  else if (!/^https?:\/\//.test(v.baseUrl.trim())) errors.baseUrl = "须以 http:// 或 https:// 开头";
  if (v.apiKey.trim() === "") errors.apiKey = "必填";
  if (v.model.trim() === "") errors.model = "必填";
  const tokens = Number(v.maxTokens);
  if (!Number.isInteger(tokens) || tokens <= 0) errors.maxTokens = "须为正整数";
  if (v.temperature.trim() !== "") {
    const t = Number(v.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) errors.temperature = "0-2 之间";
  }
  return errors;
}

export interface ProviderCardFormProps {
  card?: ProviderCardDto;
  onSave: (card: ProviderCardDto) => void;
  onCancel: () => void;
  onTest: (card: ProviderCardDto) => Promise<{ ok: boolean; message: string }>;
  onDelete?: (name: string) => void;
}

export function ProviderCardForm({
  card,
  onSave,
  onCancel,
  onTest,
  onDelete,
}: ProviderCardFormProps) {
  const [form, setForm] = useState<CardFormState>(() => formStateOf(card));
  const [errors, setErrors] = useState<CardFormErrors>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const set = (patch: Partial<CardFormState>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };

  const buildCard = (): ProviderCardDto => ({
    name: form.name.trim(),
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    maxTokens: Number(form.maxTokens),
    ...(form.temperature.trim() !== "" ? { temperature: Number(form.temperature) } : {}),
  });

  const submit = (): void => {
    const found = validateCardForm(form);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(buildCard());
  };

  const runTest = (): void => {
    const found = validateCardForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setTesting(true);
    setTestResult(null);
    onTest(buildCard())
      .then((r) => setTestResult(r.message))
      .catch((e: unknown) => setTestResult(e instanceof Error ? e.message : String(e)))
      .finally(() => setTesting(false));
  };

  return (
    <section className="tc-card" data-testid="provider-card-form">
      {card !== undefined ? <strong>编辑卡片：{card.name}</strong> : <strong>新增卡片</strong>}
      <div
        style={{
          display: "grid",
          gap: 6,
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        <Field label="卡片名" error={errors.name}>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="协议">
          <select
            value={form.protocol}
            onChange={(e) => set({ protocol: e.target.value as ProtocolOption })}
          >
            {PROTOCOL_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Base URL" error={errors.baseUrl}>
          <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
        </Field>
        <Field label="API Key" error={errors.apiKey}>
          <input value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </Field>
        <Field label="模型" error={errors.model}>
          <input value={form.model} onChange={(e) => set({ model: e.target.value })} />
        </Field>
        <Field label="maxTokens" error={errors.maxTokens}>
          <input value={form.maxTokens} onChange={(e) => set({ maxTokens: e.target.value })} />
        </Field>
        <Field label="温度（可选）" error={errors.temperature}>
          <input value={form.temperature} onChange={(e) => set({ temperature: e.target.value })} />
        </Field>
      </div>
      {testResult !== null ? <p style={{ margin: 0 }}>{testResult}</p> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={submit}>
          保存
        </Button>
        <Button disabled={testing} onClick={runTest}>
          {testing ? "测试中…" : "测试连接"}
        </Button>
        <Button onClick={onCancel}>取消</Button>
        {card !== undefined && onDelete !== undefined ? (
          <Button variant="danger" onClick={() => onDelete(card.name)}>
            删除
          </Button>
        ) : null}
      </div>
    </section>
  );
}
