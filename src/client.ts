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
  panelOpacity: 0.5,
  sidebarOpacity: 0.85,
  themeColor: '#2E8B72',
  mascotTitle: '靖妖傩舞',
  mascotSubtitle: '别挡路',
};
const CLIENT_RANGES = {
  backgroundBlur: { min: 0, max: 60 },
  panelOpacity: { min: 0.3, max: 0.9 },
  sidebarOpacity: { min: 0, max: 1 },
} as const;
const PANEL_OPACITY_MAX = 0.9;

/** 带 webkit 厂商前缀的 style（@types/react 的 DOM lib 未覆盖该属性）。 */
interface StyleWithWebkit extends CSSStyleDeclaration {
  webkitBackdropFilter?: string;
}

/** 默认主题主色：魈的青玉绿。 */
const DEFAULT_THEME_COLOR = '#2E8B72';

/**
 * 由主色派生整套青玉系配色 token（浅色 + 深色）。
 * 语义功能色（state-error/warn/success）保持固定；青玉相关的 bg/border/brand/label/sidebar 跟随主色。
 */
function buildPalette(hex: string): Record<string, ThemeTokenValue> {
  const base = parseHex(hex) || parseHex(DEFAULT_THEME_COLOR)!;
  const [h, s, l] = rgbToHsl(base[0], base[1], base[2]);
  const tone = (lightSat: number, lightL: number, darkSat: number, darkL: number): [string, string] => {
    // 返回 [lightHex, darkHex]
    const li = hslToRgb(h, Math.max(8, Math.min(90, lightSat)), lightL);
    const dk = hslToRgb(h, Math.max(8, Math.min(80, darkSat)), darkL);
    return [toHex(li[0], li[1], li[2]), toHex(dk[0], dk[1], dk[2])];
  };
  const bgBase = tone(s * 0.12, 95, s * 0.4, 7);
  const bgLayer1 = tone(s * 0.16, 90, s * 0.5, 12);
  const bgLayer2 = tone(s * 0.2, 84, s * 0.55, 16);
  const bgOverlay = tone(s * 0.1, 97, s * 0.4, 9);
  const border1 = tone(s * 0.22, 78, s * 0.5, 26);
  const border2 = tone(s * 0.28, 70, s * 0.55, 34);
  const brandDark = hslToRgb(h, Math.min(100, Math.max(40, s * 0.85)), Math.max(64, l * 1.5));
  const brand: [string, string] = [toHex(base[0], base[1], base[2]), toHex(brandDark[0], brandDark[1], brandDark[2])];
  const labelPri = tone(s * 0.4, 24, s * 0.18, 92);
  const labelSec = tone(s * 0.3, 42, s * 0.2, 72);
  const sidebar = tone(s * 0.14, 92, s * 0.45, 8);
  return {
    '--dsw-alias-bg-base': { light: bgBase[0], dark: bgBase[1] },
    '--dsw-alias-bg-layer-1': { light: bgLayer1[0], dark: bgLayer1[1] },
    '--dsw-alias-bg-layer-2': { light: bgLayer2[0], dark: bgLayer2[1] },
    '--dsw-alias-bg-overlay': { light: bgOverlay[0], dark: bgOverlay[1] },
    '--dsw-alias-border-l1': { light: border1[0], dark: border1[1] },
    '--dsw-alias-border-l2': { light: border2[0], dark: border2[1] },
    '--dsw-alias-brand-primary': { light: brand[0], dark: brand[1] },
    '--dsw-alias-label-primary': { light: labelPri[0], dark: labelPri[1] },
    '--dsw-alias-label-secondary': { light: labelSec[0], dark: labelSec[1] },
    '--dsw-alias-state-error-primary': { light: '#B4442F', dark: '#D9694F' },
    '--dsw-alias-state-success-primary': { light: '#2F7D5C', dark: '#58B08C' },
    '--dsw-alias-state-warn-primary': { light: '#B0872E', dark: '#D4AB4F' },
    '--dsw-specific-sidebar-fill': { light: sidebar[0], dark: sidebar[1] },
  };
}

/** 当前主色对应的青玉系配色 token（默认魈青玉绿，主色变化时由 buildTokens 重建）。 */
function xiaoTokens(hex: string): Record<string, ThemeTokenValue> {
  return buildPalette(hex);
}

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

/** 根据配置构建主题 token 层：背景开启时把面板底色换成半透明（浅色/深色统一受 panelOpacity 控制）。 */
function buildTokens(cfg: XiaoConfig): Record<string, ThemeTokenValue> {
  const themeColor = typeof cfg.themeColor === 'string' && cfg.themeColor.length > 0 ? cfg.themeColor : DEFAULT_THEME_COLOR;
  const tokens: Record<string, ThemeTokenValue> = xiaoTokens(themeColor);
  if (cfg.backgroundEnabled !== false) {
    // panelOpacity 作用于界面底色；封顶 0.9，保证背景图恒有 ≥10% 透出（不再因拉满而糊死背景）。
    const p = clamp01(typeof cfg.panelOpacity === 'number' ? cfg.panelOpacity : 0.5);
    const light = Math.min(p, PANEL_OPACITY_MAX);
    const dark = Math.min(p, PANEL_OPACITY_MAX);
    // 半透明底色的浅深 RGB 随主题主色派生（不再是固定青玉 RGB）。
    const surf = deriveSurfaces(themeColor);
    const [lr, lg, lb] = surf.light;
    const [dr, dg, db] = surf.dark;
    tokens['--dsw-alias-bg-base'] = { light: rgba(lr, lg, lb, light), dark: rgba(dr, dg, db, dark) };
    tokens['--dsw-alias-bg-layer-1'] = {
      light: rgba(lr, lg, lb, Math.max(light - 0.06, 0.25)),
      dark: rgba(dr, dg, db, Math.max(dark - 0.06, 0.25)),
    };
    tokens['--dsw-alias-bg-layer-2'] = {
      light: rgba(lr, lg, lb, Math.max(light - 0.1, 0.2)),
      dark: rgba(dr, dg, db, Math.max(dark - 0.1, 0.2)),
    };
    tokens['--dsw-alias-bg-overlay'] = {
      light: rgba(lr, lg, lb, Math.min(light + 0.12, PANEL_OPACITY_MAX)),
      dark: rgba(dr, dg, db, Math.min(dark + 0.12, PANEL_OPACITY_MAX)),
    };
    tokens['--dsw-specific-sidebar-fill'] = {
      light: rgba(lr, lg, lb, Math.max(light - 0.14, 0.25)),
      dark: rgba(dr, dg, db, Math.max(dark - 0.14, 0.25)),
    };
  }
  return tokens;
}

/** 定位 shell 根框架（frame）：在带 gridTemplateColumns 的候选里挑子列数最多的那个，再兜底 #root 首子元素。 */
function findFrameElement(): HTMLElement | null {
  const candidates = document.querySelectorAll('div[style*="grid-template-columns"]');
  let best: HTMLElement | null = null;
  let bestCount = -1;
  for (const el of Array.from(candidates)) {
    if (!(el instanceof HTMLElement)) continue;
    const count = el.children.length;
    const w = el.getBoundingClientRect().width;
    if (count > bestCount && w > 0) {
      bestCount = count;
      best = el;
    }
  }
  if (best) return best;
  const root = document.getElementById('root');
  if (root && root.firstElementChild && root.firstElementChild.tagName === 'DIV') {
    const w = root.firstElementChild.getBoundingClientRect().width;
    if (w > 0) return root.firstElementChild as HTMLElement;
  }
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
    de.style.removeProperty('--xiao-bg-ovl');
    de.style.removeProperty('--xiao-bg-ovl-dark');
    de.style.removeProperty('--xiao-sidebar-ovl');
    de.style.removeProperty('--xiao-sidebar-ovl-dark');
    de.style.removeProperty('--xiao-theme-color');
    de.style.removeProperty('--xiao-grad-a');
    de.style.removeProperty('--xiao-grad-b');
    if (frame) {
      frame.style.backgroundColor = '';
      frame.style.backgroundImage = '';
      frame.style.backdropFilter = '';
      (frame.style as StyleWithWebkit).webkitBackdropFilter = '';
    }
    return;
  }
  const blur = clampNum(typeof cfg.backgroundBlur === 'number' ? cfg.backgroundBlur : 22, 0, 60, 22);
  // 统一的不透明度：浅色/深色共用同一 alpha（封顶 0.9 保证背景图恒可见），仅 RGB 底色随主题区分。
  const p = clamp01(typeof cfg.panelOpacity === 'number' ? cfg.panelOpacity : 0.5);
  const ovl = Math.min(p, PANEL_OPACITY_MAX);
  // 侧栏独立不透明度：允许到 1.0（sidebar 可完全 100% 不透明），与主面板 0.9 封顶解耦。
  const so = clamp01(typeof cfg.sidebarOpacity === 'number' ? cfg.sidebarOpacity : 0.85);
  // 面板/侧栏底色的浅深 RGB 随主题主色派生。
  const surf = deriveSurfaces(typeof cfg.themeColor === 'string' ? cfg.themeColor : DEFAULT_THEME_COLOR);
  const [lr, lg, lb] = surf.light;
  const [dr, dg, db] = surf.dark;
  const themeColor = typeof cfg.themeColor === 'string' && cfg.themeColor.length > 0 ? cfg.themeColor : DEFAULT_THEME_COLOR;
  de.classList.add('xiao-bg-on');
  de.style.setProperty('--xiao-bg-img', 'url("/xiao-bg")');
  de.style.setProperty('--xiao-bg-blur', blur + 'px');
  // 背景渐变随主色：中段 = 主色，两端为同色暗/亮。
  de.style.setProperty('--xiao-theme-color', themeColor);
  de.style.setProperty('--xiao-grad-a', shiftLight(themeColor, -44));
  de.style.setProperty('--xiao-grad-b', shiftLight(themeColor, -30));
  de.style.setProperty('--xiao-bg-ovl', rgba(lr, lg, lb, ovl));
  de.style.setProperty('--xiao-bg-ovl-dark', rgba(dr, dg, db, ovl));
  // 侧栏杆：浅色/深色各一个变量，由 CSS 属性选择器套到 sidebarCol/detailsCol 上。
  de.style.setProperty('--xiao-sidebar-ovl', rgba(lr, lg, lb, so));
  de.style.setProperty('--xiao-sidebar-ovl-dark', rgba(dr, dg, db, so));
  // JS 兜底：若 CSS 选择器未命中根框架，直接给它设 inline 半透明 + 模糊
  if (frame) {
    const isDark = document.body.hasAttribute('data-ds-dark-theme');
    frame.style.backgroundColor = isDark ? rgba(dr, dg, db, ovl) : rgba(lr, lg, lb, ovl);
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

/** 解析 `#rgb` / `#rrggbb` 为 [r,g,b]。非法输入返回 null。 */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) || /^#?([0-9a-f]{3})$/i.exec(hex);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** rgb -> [h(0-360), s(0-100), l(0-100)]。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.max(0, Math.min(1, s / 100));
  const ln = Math.max(0, Math.min(1, l / 100));
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

/** 调亮/调暗一个色（delta 为 0-100 的明度偏移）。 */
function shiftLight(hex: string, delta: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return toHex(...hslToRgb(h, s, Math.max(0, Math.min(100, l + delta))));
}

/** 调整饱和度（sDelta 为 0-100 偏移）。 */
function shiftSat(hex: string, sDelta: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return toHex(...hslToRgb(h, Math.max(0, Math.min(100, s + sDelta)), l));
}

/** 同一主色下，浅色/深色主题各自的 RGB 底（面板、侧栏半透明层用）。 */
function deriveSurfaces(hex: string): { light: [number, number, number]; dark: [number, number, number] } {
  const base = parseHex(hex) || parseHex('#2E8B72')!;
  // 浅色：高亮低饱和的青玉底；深色：极暗的青玉底。
  const [h, s, l] = rgbToHsl(base[0], base[1], base[2]);
  const light = hslToRgb(h, Math.max(12, s * 0.22), 95);
  const dark = hslToRgb(h, Math.min(48, s * 0.55), 8);
  return { light, dark };
}

/** 一个可拖拽的指针位置状态。 */
interface DragState {
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  moved: boolean;
}

/** 吉祥物徽章组件：青玉底金边 + 头像 + 可配置的标题/副标。 */
function XiaoBadge({ title, subtitle }: { title: string; subtitle: string }): React.ReactElement {
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
        React.createElement('div', { className: 'xiao-title' }, title),
        React.createElement('div', { className: 'xiao-sub' }, subtitle),
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
  return React.createElement(XiaoBadge, {
    title: snapshot.mascotTitle || CLIENT_DEFAULT_CONFIG.mascotTitle,
    subtitle: snapshot.mascotSubtitle || CLIENT_DEFAULT_CONFIG.mascotSubtitle,
  });
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
  const themeColor =
    typeof cfg.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.themeColor)
      ? cfg.themeColor
      : DEFAULT_THEME_COLOR;

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
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '主题颜色'),
        React.createElement('input', {
          className: 'xiao-settings-color',
          type: 'color',
          value: themeColor,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            void saveConfig(store, { themeColor: e.target.value });
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

    // —— 吉祥物 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, '吉祥物'),
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
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '标题'),
        React.createElement('input', {
          className: 'xiao-settings-input',
          type: 'text',
          defaultValue: cfg.mascotTitle || CLIENT_DEFAULT_CONFIG.mascotTitle,
          key: cfg.mascotTitle || 'default-title',
          onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
            void saveConfig(store, { mascotTitle: e.target.value });
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, '副标'),
        React.createElement('input', {
          className: 'xiao-settings-input',
          type: 'text',
          defaultValue: cfg.mascotSubtitle || CLIENT_DEFAULT_CONFIG.mascotSubtitle,
          key: cfg.mascotSubtitle || 'default-subtitle',
          onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
            void saveConfig(store, { mascotSubtitle: e.target.value });
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
        label: '界面不透明度',
        value: clampNum(cfg.panelOpacity, CLIENT_RANGES.panelOpacity.min, CLIENT_RANGES.panelOpacity.max, 0.5),
        min: 0.3,
        max: 0.9,
        step: 0.01,
        format: (v) => Math.round(v * 100) + '%',
        onCommit: (v) => {
          if (v !== cfg.panelOpacity) void saveConfig(store, { panelOpacity: v });
        },
      }),
      React.createElement(RangeRow, {
        label: '侧栏不透明度',
        value: clampNum(cfg.sidebarOpacity, CLIENT_RANGES.sidebarOpacity.min, CLIENT_RANGES.sidebarOpacity.max, 0.85),
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => Math.round(v * 100) + '%',
        onCommit: (v) => {
          if (v !== cfg.sidebarOpacity) void saveConfig(store, { sidebarOpacity: v });
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
                panelOpacity: 0.5,
                sidebarOpacity: 0.85,
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
  'html.xiao-bg-on body{background-image:var(--xiao-bg-img),linear-gradient(135deg,var(--xiao-grad-a),var(--xiao-theme-color) 55%,var(--xiao-grad-b))!important;background-color:transparent!important;background-attachment:fixed!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;}',
  'html.xiao-bg-on body>#root>div{background:var(--xiao-bg-ovl)!important;background-image:none!important;-webkit-backdrop-filter:blur(var(--xiao-bg-blur));backdrop-filter:blur(var(--xiao-bg-blur));}',
  'html.xiao-bg-on body[data-ds-dark-theme]>#root>div{background:var(--xiao-bg-ovl-dark)!important;}',
  // 左右侧栏独立底色：用「类名后缀」属性选择器（不依赖被哈希的类名前缀），浅色/深色各一变量。
  'html.xiao-bg-on [class$="sidebarCol"],[class$="detailsCol"]{background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [class$="sidebarCol"],body[data-ds-dark-theme] [class$="detailsCol"]{background:var(--xiao-sidebar-ovl-dark)!important;}',
  // 第三方 better-sidebar 右侧面板：全局 data 属性锚点（不依赖其哈希类名），跟随侧栏不透明度。
  // 没装该插件时选择器匹配不到，天然无副作用、不会崩。
  'html.xiao-bg-on [data-dsh-panel]{background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on [data-dsh-panel] [data-dsh-pane]{background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [data-dsh-panel]{background:var(--xiao-sidebar-ovl-dark)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [data-dsh-panel] [data-dsh-pane]{background:var(--xiao-sidebar-ovl-dark)!important;}',
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
  '.xiao-settings-color{width:44px;height:44px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:none;cursor:pointer;flex:none;}',
  '.xiao-settings-color::-webkit-color-swatch-wrapper{padding:0;}',
  '.xiao-settings-color::-webkit-color-swatch{border:none;border-radius:50%;}',
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
      de.style.removeProperty('--xiao-bg-ovl');
      de.style.removeProperty('--xiao-bg-ovl-dark');
      de.style.removeProperty('--xiao-sidebar-ovl');
      de.style.removeProperty('--xiao-sidebar-ovl-dark');
      de.style.removeProperty('--xiao-theme-color');
      de.style.removeProperty('--xiao-grad-a');
      de.style.removeProperty('--xiao-grad-b');
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
