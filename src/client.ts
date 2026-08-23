/**
 * 魈主题 —— Client 半：青玉配色 + 吉祥物徽章 + 磨砂背景 + 设置页（提示词语言/自定义、背景图路径与上传、磨砂参数）。
 * 静态部署插件 bundle：由 DSH 客户端 ModuleLoader 加载，随页面启动自动生效。
 * 设置经 fetch('/xiao-theme/settings') 读写（Host 半自管配置，绕过 settings 白名单）。
 *
 * TypeScript 实现：与 xiao-ui-theme 行为一致，但经 `client.types` 强类型约束。
 * 构建时由 tsc 产出 ModuleLoader 兼容的 CommonJS，再由 scripts/wrap-client.mjs 包裹。
 */
import * as React from 'react';
import type { XiaoConfig } from './config';
import type { ClientCtx, ClientPlugin, ThemeTokenValue } from './client.types';

/**
 * 客户端保持自包含：以下默认值与范围常量在运行时不依赖任何相对模块，
 * 与 Host 半（src/config.ts）保持一致，便于 tsc 直接产出单一 lib/client.js。
 */
const CLIENT_DEFAULT_CONFIG: XiaoConfig = {
  enabled: true,
  voiceEnabled: true,
  avatarPath: 'resource/avatar.png',
  voiceLanguage: 'en',
  voicePrompt: '',
  backgroundEnabled: true,
  backgroundImagePath: 'resource/avatar.png',
  backgroundBlur: 22,
  backgroundOpacity: 0.5,
  backgroundDarkOpacity: 0.5,
};
const CLIENT_RANGES = {
  backgroundBlur: { min: 0, max: 60 },
  backgroundOpacity: { min: 0.3, max: 1 },
  backgroundDarkOpacity: { min: 0.3, max: 1 },
} as const;

/** 带 webkit 厂商前缀的 style（@types/react 的 DOM lib 未覆盖该属性）。 */
interface StyleWithWebkit extends CSSStyleDeclaration {
  webkitBackdropFilter?: string;
}

/** 魈的青玉/翠青配色 token 覆盖（浅色 + 深色）。 */
const XIAO_TOKENS: Record<string, ThemeTokenValue> = {
  '--dsw-alias-bg-base': { light: '#F1F6F3', dark: '#0E1816' },
  '--dsw-alias-bg-layer-1': { light: '#E6EFEA', dark: '#152420' },
  '--dsw-alias-bg-layer-2': { light: '#DCE8E1', dark: '#1B2E29' },
  '--dsw-alias-bg-overlay': { light: '#F7FBF9', dark: '#111D1A' },
  '--dsw-alias-border-l1': { light: '#C5DBD1', dark: '#2C443C' },
  '--dsw-alias-border-l2': { light: '#A3C4B5', dark: '#3A5A4F' },
  '--dsw-alias-brand-primary': { light: '#2E8B72', dark: '#5CC4A6' },
  '--dsw-alias-label-primary': { light: '#17342C', dark: '#DCEBE4' },
  '--dsw-alias-label-secondary': { light: '#527368', dark: '#9DB8AC' },
  '--dsw-alias-state-error-primary': { light: '#B4442F', dark: '#D9694F' },
  '--dsw-alias-state-success-primary': { light: '#2F7D5C', dark: '#58B08C' },
  '--dsw-alias-state-warn-primary': { light: '#B0872E', dark: '#D4AB4F' },
  '--dsw-specific-sidebar-fill': { light: '#E9F0EB', dark: '#0F1917' },
};

/** 极小可订阅 store：配置 + 订阅通知。 */
interface ConfigStore {
  getSnapshot(): XiaoConfig;
  set(next: XiaoConfig): void;
  subscribe(listener: () => void): () => void;
}

function createConfigStore(): ConfigStore {
  let value: XiaoConfig = { ...CLIENT_DEFAULT_CONFIG };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    set: (next) => {
      value = next;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[xiao-theme] listener failed:', error);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 从 Host 半读配置。 */
async function loadConfig(store: ConfigStore): Promise<void> {
  try {
    const response = await fetch('/xiao-theme/settings', { cache: 'no-store' });
    if (!response.ok) return;
    store.set((await response.json()) as XiaoConfig);
  } catch (error) {
    console.error('[xiao-theme] load settings failed:', error);
  }
}

/** 写配置到 Host 半，成功则以 Host 返回值为准更新 store。 */
async function saveConfig(store: ConfigStore, patch: Partial<XiaoConfig>): Promise<void> {
  const next = { ...store.getSnapshot(), ...patch };
  // 本地先更新，保证 UI 即时反馈；Host 返回值再校准
  store.set(next);
  try {
    const response = await fetch('/xiao-theme/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (response.ok) store.set((await response.json()) as XiaoConfig);
  } catch (error) {
    console.error('[xiao-theme] save settings failed:', error);
  }
}

/** 上传背景图到 Host，成功后把返回的路径写入配置。 */
async function uploadBackground(store: ConfigStore, file: File): Promise<boolean> {
  const match = /\.([a-zA-Z0-9]+)$/.exec(file.name || '');
  const ext = match ? match[1]!.toLowerCase() : 'png';
  try {
    const response = await fetch('/xiao-theme/upload?ext=.' + encodeURIComponent(ext), {
      method: 'POST',
      body: file,
    });
    if (!response.ok) {
      console.error('[xiao-theme] upload failed:', response.status);
      return false;
    }
    const data = (await response.json()) as { imagePath?: unknown };
    if (data && typeof data.imagePath === 'string' && data.imagePath.length > 0) {
      await saveConfig(store, { backgroundImagePath: data.imagePath });
      return true;
    }
  } catch (error) {
    console.error('[xiao-theme] upload failed:', error);
  }
  return false;
}

/** 根据配置构建主题 token 层：背景开启时把面板底色换成半透明，透出磨砂背景。 */
function buildTokens(cfg: XiaoConfig): Record<string, ThemeTokenValue> {
  const tokens: Record<string, ThemeTokenValue> = { ...XIAO_TOKENS };
  if (cfg.backgroundEnabled !== false) {
    const light = clamp01(typeof cfg.backgroundOpacity === 'number' ? cfg.backgroundOpacity : 0.5);
    const dark = clamp01(typeof cfg.backgroundDarkOpacity === 'number' ? cfg.backgroundDarkOpacity : 0.5);
    tokens['--dsw-alias-bg-base'] = { light: rgba(241, 246, 243, light), dark: rgba(14, 24, 22, dark) };
    tokens['--dsw-alias-bg-layer-1'] = {
      light: rgba(241, 246, 243, Math.max(light - 0.06, 0.3)),
      dark: rgba(14, 24, 22, Math.max(dark - 0.06, 0.3)),
    };
    tokens['--dsw-alias-bg-layer-2'] = {
      light: rgba(241, 246, 243, Math.max(light - 0.1, 0.25)),
      dark: rgba(14, 24, 22, Math.max(dark - 0.1, 0.25)),
    };
    tokens['--dsw-alias-bg-overlay'] = {
      light: rgba(247, 251, 249, Math.min(light + 0.12, 0.97)),
      dark: rgba(17, 29, 26, Math.min(dark + 0.12, 0.97)),
    };
    tokens['--dsw-specific-sidebar-fill'] = {
      light: rgba(233, 240, 235, Math.max(light - 0.14, 0.3)),
      dark: rgba(15, 25, 23, Math.max(dark - 0.14, 0.3)),
    };
  }
  return tokens;
}

/** 定位 shell 根框架（frame）：它是 #root 的第一个块级子元素（AppFrame 渲染的 grid 容器）。 */
function findFrameElement(): HTMLElement | null {
  const root = document.getElementById('root');
  if (root && root.firstElementChild && root.firstElementChild.tagName === 'DIV') {
    return root.firstElementChild as HTMLElement;
  }
  const grid = document.querySelector('div[style*="grid-template-columns"]');
  if (grid) return grid as HTMLElement;
  return (document.querySelector('#root > div') as HTMLElement | null) || null;
}

/**
 * 按配置应用 / 更新 / 移除整页磨砂背景。
 * 背景图铺在 body 上（一定可见），根框架强制半透明并加 backdrop-filter 模糊，
 * 让 body 背景图透出并产生磨砂效果——不依赖 z-index、不依赖主题服务。
 */
function syncBackground(cfg: XiaoConfig): void {
  const de = document.documentElement;
  const on = cfg.enabled !== false && cfg.backgroundEnabled !== false;
  const frame = findFrameElement();
  if (!on) {
    de.classList.remove('xiao-bg-on');
    de.style.removeProperty('--xiao-bg-img');
    de.style.removeProperty('--xiao-bg-blur');
    de.style.removeProperty('--xiao-bg-ovl-light');
    de.style.removeProperty('--xiao-bg-ovl-dark');
    if (frame) {
      frame.style.backgroundColor = '';
      frame.style.backgroundImage = '';
      frame.style.backdropFilter = '';
      (frame.style as StyleWithWebkit).webkitBackdropFilter = '';
    }
    return;
  }
  const blur = clampNum(typeof cfg.backgroundBlur === 'number' ? cfg.backgroundBlur : 22, 0, 60, 22);
  const light = clamp01(typeof cfg.backgroundOpacity === 'number' ? cfg.backgroundOpacity : 0.5);
  const dark = clamp01(typeof cfg.backgroundDarkOpacity === 'number' ? cfg.backgroundDarkOpacity : 0.5);
  de.classList.add('xiao-bg-on');
  de.style.setProperty('--xiao-bg-img', 'url("/xiao-bg")');
  de.style.setProperty('--xiao-bg-blur', blur + 'px');
  de.style.setProperty('--xiao-bg-ovl-light', rgba(241, 246, 243, light));
  de.style.setProperty('--xiao-bg-ovl-dark', rgba(14, 24, 22, dark));
  // JS 兜底：若 CSS 选择器未命中根框架，直接给它设 inline 半透明 + 模糊
  if (frame) {
    const isDark = document.body.hasAttribute('data-ds-dark-theme');
    frame.style.backgroundColor = isDark ? rgba(14, 24, 22, dark) : rgba(241, 246, 243, light);
    frame.style.backgroundImage = 'none';
    frame.style.backdropFilter = 'blur(' + blur + 'px)';
    (frame.style as StyleWithWebkit).webkitBackdropFilter = 'blur(' + blur + 'px)';
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampNum(value: number, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function rgba(r: number, g: number, b: number, a: number): string {
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
}

/** 一个可拖拽的指针位置状态。 */
interface DragState {
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  moved: boolean;
}

/** 吉祥物徽章组件：青玉底金边 + 头像 + 靖妖傩舞。 */
function XiaoBadge(): React.ReactElement {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [hidden, setHidden] = React.useState(false);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDrag({
      startX: e.clientX,
      startY: e.clientY,
      originLeft: pos ? pos.x : rect.left,
      originTop: pos ? pos.y : rect.top,
      moved: false,
    });
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4;
    if (moved) {
      setDrag({ ...drag, moved });
      setPos({ x: drag.originLeft + dx, y: drag.originTop + dy });
    }
  };
  const endDrag = (): void => setDrag(null);

  const tabDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDrag({
      startX: e.clientX,
      startY: e.clientY,
      originLeft: pos ? pos.x : rect.left,
      originTop: pos ? pos.y : rect.top,
      moved: false,
    });
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
  const tabMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4;
    if (moved) {
      setDrag({ ...drag, moved });
      setPos({ x: drag.originLeft + dx, y: drag.originTop + dy });
    }
  };
  const tabUp = (): void => {
    if (drag && !drag.moved) setHidden(false);
    setDrag(null);
  };
  const tabCancel = (): void => setDrag(null);

  const styleFor: React.CSSProperties | undefined = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : undefined;

  if (hidden) {
    return React.createElement(
      'div',
      {
        className: 'xiao-mascot',
        style: styleFor,
        title: '按住拖动，轻点重新打开',
      },
      React.createElement(
        'button',
        {
          className: 'xiao-tab',
          'aria-label': '重新显示魈主题提示',
          onPointerDown: tabDown,
          onPointerMove: tabMove,
          onPointerUp: tabUp,
          onPointerCancel: tabCancel,
        },
        '\u{1F4A8}',
      ),
    );
  }

  return React.createElement(
    'div',
    {
      className: 'xiao-mascot',
      style: styleFor,
      title: '按住拖动，点 × 关闭',
      onPointerDown: startDrag,
      onPointerMove: onMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    React.createElement(
      'div',
      { className: 'xiao-badge' },
      React.createElement('img', {
        className: 'xiao-avatar',
        src: '/xiao-avatar.png',
        alt: '魈',
        draggable: 'false',
      }),
      React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'xiao-title' }, '靖妖傩舞'),
        React.createElement('div', { className: 'xiao-sub' }, '别挡路'),
      ),
      React.createElement(
        'button',
        {
          className: 'xiao-close',
          'aria-label': '关闭魈主题提示',
          title: '关闭（可随时从风印重新打开）',
          onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => e.stopPropagation(),
          onClick: () => setHidden(true),
        },
        '\u00d7',
      ),
    ),
    React.createElement('div', { className: 'xiao-wind', 'aria-hidden': 'true' }, '\u{1F4A8} \u{1F4A8} \u{1F4A8}'),
  );
}

/** 悬浮窗组件：订阅配置，enabled=false 时隐藏。 */
function XiaoOverlay({ store }: { store: ConfigStore }): React.ReactElement | null {
  const [snapshot, setSnapshot] = React.useState<XiaoConfig>(() => store.getSnapshot());
  React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
  if (snapshot.enabled === false) return null;
  return React.createElement(XiaoBadge);
}

/** 滑块行：拖动过程本地预览，松开 / 失焦 / 键盘确认时提交。 */
function RangeRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onCommit: (v: number) => void;
}): React.ReactElement {
  const [val, setVal] = React.useState<number>(value);
  React.useEffect(() => setVal(value), [value]);
  const commit = (): void => onCommit(val);
  return React.createElement(
    'div',
    { className: 'xiao-settings-row' },
    React.createElement('label', { className: 'xiao-settings-label' }, label),
    React.createElement('input', {
      className: 'xiao-settings-range',
      type: 'range',
      min,
      max,
      step,
      value: val,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setVal(Number(e.target.value)),
      onPointerUp: commit,
      onKeyUp: commit,
      onBlur: commit,
    }),
    React.createElement('span', { className: 'xiao-settings-value' }, format ? format(val) : String(val)),
  );
}

/** 设置页组件：提示词（语言/自定义/恢复默认）+ 头像 + 磨砂背景（开关/路径/上传/参数）。 */
function XiaoSettingsPage({ store }: { store: ConfigStore }): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<XiaoConfig>(() => store.getSnapshot());
  React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
  const cfg = snapshot;
  const enabled = cfg.enabled !== false;
  const voiceEnabled = cfg.voiceEnabled !== false;
  const avatarPath = cfg.avatarPath || CLIENT_DEFAULT_CONFIG.avatarPath;
  const voiceLanguage = cfg.voiceLanguage === 'zh' ? 'zh' : 'en';
  const voicePrompt = cfg.voicePrompt || '';
  const bgEnabled = cfg.backgroundEnabled !== false;
  const bgPath = cfg.backgroundImagePath || CLIENT_DEFAULT_CONFIG.backgroundImagePath;

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) void uploadBackground(store, file);
  };

  return React.createElement(
    'div',
    { className: 'xiao-settings' },
    // —— 总开关 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, '魈主题'),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '启用魈主题'),
        React.createElement('input', {
          type: 'checkbox',
          checked: enabled,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            void saveConfig(store, { enabled: e.target.checked });
          },
        }),
      ),
    ),

    // —— 提示词 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, '提示词'),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '注入语气'),
        React.createElement('input', {
          type: 'checkbox',
          checked: voiceEnabled,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            void saveConfig(store, { voiceEnabled: e.target.checked });
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '模板语言'),
        React.createElement(
          'select',
          {
            className: 'xiao-settings-select',
            value: voiceLanguage,
            disabled: !voiceEnabled,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              void saveConfig(store, { voiceLanguage: e.target.value as 'en' | 'zh' });
            },
          },
          React.createElement('option', { value: 'en' }, 'English'),
          React.createElement('option', { value: 'zh' }, '中文'),
        ),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row xiao-settings-row-top' },
        React.createElement('label', { className: 'xiao-settings-label' }, '自定义提示词'),
        React.createElement('textarea', {
          className: 'xiao-settings-textarea',
          defaultValue: voicePrompt,
          key: voicePrompt,
          rows: 5,
          disabled: !voiceEnabled,
          placeholder: '留空则使用所选语言的默认模板；填写后优先使用自定义文本。',
          onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => {
            const next = e.target.value;
            if (next !== cfg.voicePrompt) void saveConfig(store, { voicePrompt: next });
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            disabled: !voiceEnabled,
            onClick: () => void saveConfig(store, { voiceLanguage: 'en', voicePrompt: '', voiceEnabled: true }),
          },
          '恢复提示词默认',
        ),
      ),
    ),

    // —— 头像 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, '头像'),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '头像图片路径'),
        React.createElement('input', {
          className: 'xiao-settings-input',
          type: 'text',
          defaultValue: avatarPath,
          key: avatarPath,
          onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
            const next = e.target.value.trim();
            if (next.length > 0) void saveConfig(store, { avatarPath: next });
          },
        }),
      ),
    ),

    // —— 磨砂背景 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, '磨砂背景'),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '启用磨砂背景'),
        React.createElement('input', {
          type: 'checkbox',
          checked: bgEnabled,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            void saveConfig(store, { backgroundEnabled: e.target.checked });
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '背景图路径'),
        React.createElement('input', {
          className: 'xiao-settings-input',
          type: 'text',
          defaultValue: bgPath,
          key: bgPath,
          onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
            const next = e.target.value.trim();
            if (next.length > 0) void saveConfig(store, { backgroundImagePath: next });
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '上传背景图'),
        React.createElement('input', {
          className: 'xiao-settings-file',
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
          onChange: onPickFile,
        }),
      ),
      React.createElement(RangeRow, {
        label: '磨砂强度',
        value: clampNum(cfg.backgroundBlur, CLIENT_RANGES.backgroundBlur.min, CLIENT_RANGES.backgroundBlur.max, 22),
        min: 0,
        max: 60,
        step: 1,
        format: (v) => v + 'px',
        onCommit: (v) => {
          if (v !== cfg.backgroundBlur) void saveConfig(store, { backgroundBlur: v });
        },
      }),
      React.createElement(RangeRow, {
        label: '浅色遮罩',
        value: clampNum(cfg.backgroundOpacity, CLIENT_RANGES.backgroundOpacity.min, CLIENT_RANGES.backgroundOpacity.max, 0.5),
        min: 0.3,
        max: 1,
        step: 0.01,
        format: (v) => Math.round(v * 100) + '%',
        onCommit: (v) => {
          if (v !== cfg.backgroundOpacity) void saveConfig(store, { backgroundOpacity: v });
        },
      }),
      React.createElement(RangeRow, {
        label: '深色遮罩',
        value: clampNum(cfg.backgroundDarkOpacity, CLIENT_RANGES.backgroundDarkOpacity.min, CLIENT_RANGES.backgroundDarkOpacity.max, 0.84),
        min: 0.3,
        max: 1,
        step: 0.01,
        format: (v) => Math.round(v * 100) + '%',
        onCommit: (v) => {
          if (v !== cfg.backgroundDarkOpacity) void saveConfig(store, { backgroundDarkOpacity: v });
        },
      }),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            onClick: () =>
              void saveConfig(store, {
                backgroundEnabled: true,
                backgroundImagePath: 'resource/avatar.png',
                backgroundBlur: 22,
                backgroundOpacity: 0.5,
                backgroundDarkOpacity: 0.5,
              }),
          },
          '恢复背景默认',
        ),
      ),
    ),

    React.createElement(
      'div',
      { className: 'xiao-settings-hint' },
      '改动即时生效。背景图路径支持相对插件目录（如 resource/avatar.png）或本地绝对路径，也可直接上传图片（保存到 ~/.dsh/xiao-theme-uploads/）。',
    ),
  );
}

const XIAO_CSS: string[] = [
  'html.xiao-bg-on,html.xiao-bg-on body{background-color:transparent!important;}',
  'html.xiao-bg-on body{background-image:var(--xiao-bg-img),linear-gradient(135deg,#1c463a,#2E8B72 55%,#0e1816)!important;background-color:transparent!important;background-attachment:fixed!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;}',
  'html.xiao-bg-on body>#root>div{background:var(--xiao-bg-ovl-light)!important;background-image:none!important;-webkit-backdrop-filter:blur(var(--xiao-bg-blur));backdrop-filter:blur(var(--xiao-bg-blur));}',
  'html.xiao-bg-on body[data-ds-dark-theme]>#root>div{background:var(--xiao-bg-ovl-dark)!important;}',
  '.xiao-mascot{position:fixed;right:18px;bottom:18px;z-index:2147483000;pointer-events:auto;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;}',
  '.xiao-badge{display:flex;align-items:center;gap:10px;padding:8px 12px 8px 10px;border-radius:999px;background:linear-gradient(135deg,var(--dsw-alias-bg-overlay),var(--dsw-alias-bg-layer-1));border:2px solid #C9A96B;box-shadow:0 6px 20px rgba(20,60,50,0.30);white-space:nowrap;}',
  '.xiao-avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;border:2px solid #C9A96B;flex:none;}',
  '.xiao-title{font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary);letter-spacing:1px;}',
  '.xiao-sub{font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:2px;margin-top:1px;}',
  '.xiao-close{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;padding:2px 6px;border-radius:50%;margin-left:2px;}',
  '.xiao-close:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);}',
  '.xiao-tab{border:2px solid #C9A96B;background:linear-gradient(135deg,var(--dsw-alias-bg-overlay),var(--dsw-alias-bg-layer-1));cursor:grab;width:44px;height:44px;border-radius:50%;font-size:20px;line-height:1;box-shadow:0 6px 20px rgba(20,60,50,0.30);animation:xiao-float 3s ease-in-out infinite alternate;}',
  '.xiao-tab:hover{border-color:var(--dsw-alias-state-warn-primary);}',
  '.xiao-wind{font-size:14px;letter-spacing:6px;opacity:0.9;animation:xiao-float 3s ease-in-out infinite alternate;}',
  '@keyframes xiao-float{from{transform:translateY(0);}to{transform:translateY(-5px);}}',
  '.xiao-settings{display:flex;flex-direction:column;gap:6px;padding:4px 0;max-width:640px;}',
  '.xiao-settings-section{display:flex;flex-direction:column;gap:10px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);}',
  '.xiao-settings-section:last-of-type{border-bottom:none;}',
  '.xiao-settings-title{font-size:13px;font-weight:700;color:var(--dsw-alias-brand-primary);letter-spacing:1px;}',
  '.xiao-settings-row{display:flex;align-items:center;gap:12px;}',
  '.xiao-settings-row-top{align-items:flex-start;}',
  '.xiao-settings-label{font-size:14px;color:var(--dsw-alias-label-primary);min-width:110px;flex:none;}',
  '.xiao-settings-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px;}',
  '.xiao-settings-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;font-size:13px;}',
  '.xiao-settings-textarea{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;line-height:1.5;}',
  '.xiao-settings-range{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary);}',
  '.xiao-settings-value{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:44px;text-align:right;flex:none;}',
  '.xiao-settings-file{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-secondary);}',
  '.xiao-settings-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}',
  '.xiao-settings-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.xiao-settings-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
];

const XIAO_CSS_STRING = XIAO_CSS.join('');

/** 注入包级样式（随插件卸载移除）。 */
function insertStyles(ctx: ClientCtx): void {
  const tag = document.createElement('style');
  tag.dataset.plugin = 'xiao-theme-ts';
  tag.dataset.pluginCss = 'xiao-theme-ts/styles.css';
  tag.textContent = XIAO_CSS_STRING;
  document.head.appendChild(tag);
  ctx.effect(
    () => () => {
      tag.remove();
    },
    'xiao-theme: styles',
  );
}

const inject = ['slots', 'theme'] as const;

function apply(ctx: ClientCtx): void {
  const store = createConfigStore();

  // 主题覆盖：单层动态合并（青玉配色 + 背景开启时的半透明面板色）
  const theme = ctx.get('theme');
  let themeDispose: (() => void) | null = null;
  const syncTheme = (): void => {
    const cfg = store.getSnapshot();
    const enabled = cfg.enabled !== false;
    if (!enabled) {
      if (themeDispose !== null) {
        themeDispose();
        themeDispose = null;
      }
      return;
    }
    if (theme === undefined) return;
    themeDispose = theme.overrideTokens('xiao-theme-static', buildTokens(cfg));
  };
  ctx.effect(() => store.subscribe(syncTheme), 'xiao-theme: theme sync');
  ctx.effect(
    () => () => {
      if (themeDispose !== null) themeDispose();
    },
    'xiao-theme: theme cleanup',
  );

  // 磨砂背景层
  const syncBg = (): void => syncBackground(store.getSnapshot());
  ctx.effect(() => store.subscribe(syncBg), 'xiao-theme: background sync');
  ctx.effect(
    () => () => {
      const de = document.documentElement;
      de.classList.remove('xiao-bg-on');
      de.style.removeProperty('--xiao-bg-img');
      de.style.removeProperty('--xiao-bg-blur');
      de.style.removeProperty('--xiao-bg-ovl-light');
      de.style.removeProperty('--xiao-bg-ovl-dark');
      const frame = findFrameElement();
      if (frame) {
        frame.style.backgroundColor = '';
        frame.style.backgroundImage = '';
        frame.style.backdropFilter = '';
        (frame.style as StyleWithWebkit).webkitBackdropFilter = '';
      }
    },
    'xiao-theme: background cleanup',
  );

  // 初次读配置，读完后同步主题 + 背景 + 驱动 UI
  void loadConfig(store).then(() => {
    syncTheme();
    syncBg();
  });
  syncTheme();
  syncBg();

  insertStyles(ctx);

  const slots = ctx.get('slots');
  if (slots === undefined) return;
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'xiao-mascot' }, () =>
      React.createElement(XiaoOverlay, { store }),
    ),
  );
  slots.inject('settings.section', () =>
    slots.register({ name: 'settings.section', id: 'xiao-theme-ts', order: 100, label: '魈主题' }, () =>
      React.createElement(XiaoSettingsPage, { store }),
    ),
  );
}

export { inject, apply };
export default { inject, apply } satisfies ClientPlugin;
