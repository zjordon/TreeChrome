// ModelSwitcher（#37 批 C）：模型快速切换 overlay 内容——get-settings 热读卡
// 列表，ProviderList 点选即 save-settings activeCard（下一任务生效）。宿主注入
// options 单发 request 工厂（与 OptionsApp 同款形态）；SW 被杀等失败 fail-soft
// 呈现错误行。零 chrome。

import type { OptionsOp, ProviderCardDto } from "@tw/protocol";
import { useEffect, useState } from "react";
import { ProviderList } from "./provider-list.js";

export interface ModelSwitcherProps {
  request: (op: OptionsOp, payload?: unknown) => Promise<unknown>;
  onClose: () => void;
}

interface SettingsShape {
  providerCards: ProviderCardDto[];
  activeCard: string;
}

export function ModelSwitcher({ request, onClose }: ModelSwitcherProps) {
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void request("get-settings")
      .then((res) => {
        const s = res as { ok?: boolean; error?: string; settings?: SettingsShape };
        if (s?.ok === true && s.settings !== undefined) setSettings(s.settings);
        else setError(s?.error ?? "读取配置失败");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [request]);

  const activate = (name: string): void => {
    if (settings === null || busy) return;
    setBusy(true);
    void request("save-settings", { ...settings, activeCard: name })
      .then((res) => {
        if ((res as { ok?: boolean }).ok === true) {
          setSettings({ ...settings, activeCard: name });
          onClose();
        } else {
          setError((res as { error?: string }).error ?? "保存失败");
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="model-switcher">
      {error !== null ? <p className="tc-ev-err">{error}</p> : null}
      {settings === null && error === null ? <p className="tc-ev-muted">读取配置中…</p> : null}
      {settings !== null ? (
        <ProviderList
          cards={settings.providerCards}
          activeCard={settings.activeCard}
          onActivate={activate}
          onEdit={() => onClose()}
          onAdd={() => onClose()}
        />
      ) : null}
      <p className="tc-ev-muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
        点选即切换活跃卡（下一任务生效）；编辑/新增去设置页。
      </p>
    </div>
  );
}
