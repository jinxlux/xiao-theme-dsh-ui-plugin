/**
 * 魈主题 —— Client 半：青玉配色 + 吉祥物徽章 + 磨砂背景 + 设置页（提示词语言/自定义、背景图路径与上传、磨砂参数）。
 * 静态部署插件 bundle：由 DSH 客户端 ModuleLoader 加载，随页面启动自动生效。
 * 设置经 fetch('/xiao-theme/settings') 读写（Host 半自管配置，绕过 settings 白名单）。
 *
 * TypeScript 实现：与 xiao-ui-theme 行为一致，但经 `client.types` 强类型约束。
 * 构建时由 tsc 产出 ModuleLoader 兼容的 CommonJS，再由 scripts/wrap-client.mjs 包裹。
 */
import * as React from 'react';
import type { XiaoConfig, ThemeSummary, ThemeListResponse, ThemeActivateResponse, ThemeExport, UploadEntry, UploadListResponse } from './config';
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
  backgroundDynamic: false,
  backgroundVideoAudio: false,
  backgroundBlur: 22,
  panelOpacity: 0.5,
  sidebarOpacity: 0.85,
  themeColor: '#2E8B72',
  mascotTitle: '靖妖傩舞',
  mascotSubtitle: '别挡路',
  // 角色空间：**默认关闭**（老用户升级不会凭空多出一个 agent preset）；空字符串 = 使用 Host 内置的英文默认角色（魈）。
  roleplayEnabled: false,
  roleplayPersona: '',
  roleplayNetwork: false,
};
const CLIENT_RANGES = {
  backgroundBlur: { min: 0, max: 60 },
  panelOpacity: { min: 0.3, max: 0.9 },
  sidebarOpacity: { min: 0, max: 1 },
} as const;
const PANEL_OPACITY_MAX = 0.9;

let bgVersion = 0;
let avatarVersion = 0;

/** DSH 当前界面语言（<html lang>）：zh* => 中文，否则英文。 */
function currentLangZh(): boolean {
  const lang = (document.documentElement.lang || '').toLowerCase();
  return lang.startsWith('zh');
}

/** 把 DSH 界面语言随 x-xiao-lang 头发给 Host，用于错误文案本地化。 */
function xiaoLangHeader(): Record<string, string> {
  return { 'x-xiao-lang': currentLangZh() ? 'zh' : 'en' };
}

/** 设置页 / 主题管理 / 徽章提示的文案字典（跟随 DSH 界面语言）。 */
const STR: Record<string, { zh: string; en: string }> = {
  themeTitle: { zh: '魈主题', en: 'Xiao Theme' },
  enableTheme: { zh: '启用魈主题', en: 'Enable Xiao theme' },
  themeColor: { zh: '主题颜色', en: 'Theme color' },
  voiceSection: { zh: '语气（工作会话）', en: 'Voice (work sessions)' },
  voiceSectionHint: { zh: '只改变说话方式：内容、工具与执行方式完全不变，不注入任何角色身份。', en: 'Tone only: the substance, tools and execution stay exactly the same; no character identity is injected.' },
  injectVoice: { zh: '注入语气', en: 'Inject voice' },
  templateLang: { zh: '模板语言', en: 'Template language' },
  customPrompt: { zh: '自定义提示词', en: 'Custom prompt' },
  promptPlaceholder: { zh: '留空则使用所选语言的默认模板；填写后优先使用自定义文本。', en: 'Leave empty to use the default template of the selected language; a custom prompt is used when set.' },
  restorePrompt: { zh: '恢复提示词默认', en: 'Reset prompt' },
  restoreThemeColor: { zh: '恢复主题颜色默认', en: 'Reset theme color' },
  restoreMascot: { zh: '恢复吉祥物默认', en: 'Reset mascot' },
  mascotSection: { zh: '吉祥物', en: 'Mascot' },
  avatarPath: { zh: '头像图片路径', en: 'Avatar image path' },
  titleField: { zh: '标题', en: 'Title' },
  subtitleField: { zh: '副标', en: 'Subtitle' },
  bgSection: { zh: '磨砂背景', en: 'Frosted background' },
  enableBg: { zh: '启用磨砂背景', en: 'Enable frosted background' },
  bgPath: { zh: '背景图路径', en: 'Background image path' },
  uploadBg: { zh: '选择/上传背景图', en: 'Choose/upload background' },
  uploadAvatar: { zh: '选择/上传头像', en: 'Choose/upload avatar' },
  uploadsTitle: { zh: '管理上传文件', en: 'Manage uploads' },
  uploadsEmpty: { zh: '还没有上传文件。点下方「上传」即可新增，或打开文件夹放入文件后刷新。', en: 'No uploaded files yet. Tap "Upload" below to add one, or open the folder to drop files then refresh.' },
  uploadsUse: { zh: '使用此文件', en: 'Use this file' },
  uploadsOpenFolder: { zh: '打开上传文件夹', en: 'Open upload folder' },
  uploadsClose: { zh: '关闭', en: 'Close' },
  uploadsCurrent: { zh: '当前使用', en: 'In use' },
  uploadsUsedBy: { zh: '用于', en: 'Used by' },
  uploadsFetchError: { zh: '读取上传列表失败', en: 'Failed to load uploads' },
  uploadsUpload: { zh: '上传', en: 'Upload' },
  uploadsUploading: { zh: '上传中…', en: 'Uploading…' },
  uploadsUploadFailed: { zh: '上传失败', en: 'Upload failed' },
  uploadsFolderOpened: { zh: '已尝试打开上传文件夹', en: 'Attempted to open the upload folder' },
  uploadsFolderFailed: { zh: '打开失败，请手动前往此目录', en: 'Failed to open. Go to the folder manually:' },
  blurStrength: { zh: '磨砂强度', en: 'Blur strength' },
  uiOpacity: { zh: '界面不透明度', en: 'UI opacity' },
  sidebarOpacity: { zh: '侧栏不透明度', en: 'Sidebar opacity' },
  useStaticDefault: { zh: '使用静态背景默认', en: 'Use static background default' },
  useDynamicExample: { zh: '使用动态背景示例', en: 'Use dynamic GIF example' },
  videoAudio: { zh: '视频背景声音', en: 'Background video audio' },
  settingsHint: { zh: '改动即时生效。背景图/头像路径支持相对插件目录（如 resource/avatar.png）或本地绝对路径，也可直接上传图片/视频（保存到 ~/.dsh/xiao-theme-uploads/）。上传 GIF 动图或 MP4/WebM 视频会自动识别为动态背景（视频背景可在下方选择是否播放声音）；静态图片或单帧 GIF 仍按原静态磨砂背景处理。头像同样可通过上传替换。', en: 'Changes take effect immediately. The background/avatar path supports a plugin-relative path (e.g. resource/avatar.png) or a local absolute path; you can also upload an image or video (saved to ~/.dsh/xiao-theme-uploads/). An uploaded animated GIF or MP4/WebM video is auto-detected as a dynamic background (video backgrounds can optionally play sound below); static images or single-frame GIFs keep the static frosted treatment. The avatar can also be replaced by uploading.' },
  themeManager: { zh: '主题管理', en: 'Theme management' },
  themeManagerHint: { zh: '所有设置修改都会自动保存为当前主题修改。如果想创建新主题，请用「另存为新主题」创建，再在新主题下修改，才不会覆盖现在这个主题的设置。', en: 'All setting changes are automatically saved to the current theme. To create a new theme, use "Save as new theme" first, then edit under that new theme so you don\'t overwrite the current theme\'s settings.' },
  currentTheme: { zh: '当前主题', en: 'Current theme' },
  saveAsNewTheme: { zh: '另存为新主题', en: 'Save as new theme' },
  themeNamePlaceholder: { zh: '主题名称', en: 'Theme name' },
  save: { zh: '保存', en: 'Save' },
  restoreDefault: { zh: '恢复默认', en: 'Restore defaults' },
  restoreCurrentTheme: { zh: '恢复当前主题默认', en: 'Restore current theme to defaults' },
  confirmRestore: { zh: '确认恢复默认', en: 'Confirm restore' },
  restoreWarn: { zh: '注意：恢复默认会把【整个设置】重置回最初的「魈」主题（出厂默认值）。若当前使用的是其它主题，请谨慎使用。', en: 'Caution: restoring defaults resets the ENTIRE settings back to the original "Xiao" theme (factory defaults). If you are currently on another theme, use with care.' },
  rename: { zh: '重命名', en: 'Rename' },
  exportTheme: { zh: '导出', en: 'Export' },
  deleteTheme: { zh: '删除', en: 'Delete' },
  confirmDelete: { zh: '确认删除', en: 'Confirm delete' },
  builtinSuffix: { zh: '（内置）', en: ' (built-in)' },
  activeSuffix: { zh: '（当前）', en: ' (active)' },
  importTheme: { zh: '导入主题', en: 'Import theme' },
  importThemePrefix: { zh: '导入主题 ', en: 'Imported theme ' },
  refresh: { zh: '刷新', en: 'Refresh' },
  needThemeName: { zh: '请输入主题名称', en: 'Please enter a theme name' },
  invalidImportFile: { zh: '无效的导入文件', en: 'Invalid import file' },
  importMissingConfig: { zh: '导入文件缺少 config', en: 'Import file is missing config' },
  builtinNotDelete: { zh: '内置主题不可删除', en: 'Built-in theme cannot be deleted' },
  mascotDragClose: { zh: '按住拖动，点 × 关闭', en: 'Drag to move, click × to close' },
  mascotDragOpen: { zh: '按住拖动，轻点重新打开', en: 'Drag to move, tap to reopen' },
  mascotShow: { zh: '重新显示魈主题提示', en: 'Show the Xiao theme badge' },
  mascotClose: { zh: '关闭魈主题提示', en: 'Close the Xiao theme badge' },
  // —— 角色空间（娱乐）——
  roleplaySection: { zh: '角色空间（娱乐）', en: 'Roleplay (entertainment)' },
  roleplayEnable: { zh: '启用角色空间', en: 'Enable roleplay' },
  roleplayNetwork: { zh: '允许网络检索', en: 'Allow web lookup' },
  roleplayNetworkHint: { zh: '开启后，角色会话会挂载 DSH 的网络工具（web_search / web_fetch），让角色开演前能先查最新的剧情、形象与设定；文件、命令、任务权限仍然没有。默认关闭。', en: 'When on, the roleplay session mounts DSH web tools (web_search / web_fetch) so the character can look up the latest plot, design and lore before playing; file, command and task access stay blocked. Off by default.' },
  roleplayPersona: { zh: '角色系统提示词', en: 'Roleplay system prompt' },
  roleplayPersonaPlaceholder: { zh: '留空使用内置的「魈」角色设定（英文）；填入任意角色的完整设定即可换角色。', en: 'Leave empty to use the built-in Xiao role (English); paste any full character prompt to switch roles.' },
  roleplayApply: { zh: '应用/更新预设', en: 'Apply / update preset' },
  roleplayResetPersona: { zh: '恢复默认角色（魈）', en: 'Reset to default role (Xiao)' },
  roleplayOpenFolder: { zh: '打开预设文件夹', en: 'Open preset folder' },
  roleplayApplied: { zh: '已按当前角色文本更新预设', en: 'Preset updated from the current role text' },
  roleplayStatusInstalled: { zh: '预设已安装', en: 'Preset installed' },
  roleplayStatusMissing: { zh: '预设未安装', en: 'Preset not installed' },
  roleplayStatusOff: { zh: '角色空间已关闭（未安装预设）', en: 'Roleplay is off (no preset installed)' },
  roleplayStatusMasterOff: { zh: '「启用魈主题」总开关已关闭：角色空间不生效，预设已移除。', en: 'The "Enable Xiao theme" master switch is off: roleplay is inactive and its preset has been removed.' },
  roleplayStatusUnknown: { zh: '读取预设状态失败', en: 'Failed to read preset status' },
  roleplayHint: { zh: '默认关闭：打开上面的开关才会安装预设。角色会话是一个独立会话：开一个新会话，在顶部选择「角色空间（娱乐）」预设即可进入角色。它使用上面的完整角色设定作为系统提示词，且不挂载任何文件/命令工具，因此不会影响也不需要牺牲工作会话的能力；两边的历史互不相通。', en: 'Off by default: turn the switch above on to install the preset. A roleplay session is a separate session: start a new session and pick the "Roleplay" preset at the top to enter character. It uses the full character prompt above as its system prompt and mounts no file or command tools, so a work session\'s capability is neither affected nor traded away; the two keep separate histories.' },
  roleplayHintWork: { zh: '工作会话只保留上方的「语气」注入，永不注入角色身份。', en: 'Work sessions keep only the tone injection above and never receive a character identity.' },
  mascotCloseTip: { zh: '关闭（可随时从风印重新打开）', en: 'Close (reopen anytime from the wind mark)' },
};

/** 取当前语言的文案；未知 key 原样返回。 */
function t(key: string): string {
  const entry = STR[key];
  if (!entry) return key;
  return currentLangZh() ? entry.zh : entry.en;
}

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
    const response = await fetch('/xiao-theme/settings', { cache: 'no-store', headers: xiaoLangHeader() });
    if (!response.ok) return;
    store.set((await response.json()) as XiaoConfig);
  } catch (error) {
    console.error('[xiao-theme] load settings failed:', error);
  }
}

/** 写配置到 Host 半，成功则以 Host 返回值为准更新 store。 */
async function saveConfig(store: ConfigStore, patch: Partial<XiaoConfig>): Promise<void> {
  const prevPath = store.getSnapshot().backgroundImagePath;
  const prevAvatar = store.getSnapshot().avatarPath;
  const next = { ...store.getSnapshot(), ...patch };
  // 本地先更新，保证 UI 即时反馈；Host 返回值再校准
  store.set(next);
  try {
    const response = await fetch('/xiao-theme/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...xiaoLangHeader() },
      body: JSON.stringify(next),
    });
    if (response.ok) {
      const saved = (await response.json()) as XiaoConfig;
      // 背景图路径变化：等配置真正写回后 +1 版本号，让背景 URL 变化并重新拉取，避免竞态拿到旧图。
      if (saved.backgroundImagePath !== prevPath) bgVersion++;
      // 头像路径变化同理：+1 版本号让徽章 <img> 的缓存指纹变化，避免上传后仍显示旧头像。
      if (saved.avatarPath !== prevAvatar) avatarVersion++;
      store.set(saved);
    }
  } catch (error) {
    console.error('[xiao-theme] save settings failed:', error);
  }
}

/** 把「当前主题」整体重置为出厂默认配置（Host 侧 restoreDefaults=true）。 */
async function restoreConfig(store: ConfigStore): Promise<void> {
  const response = await fetch('/xiao-theme/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...xiaoLangHeader() },
    body: JSON.stringify({ restoreDefaults: true }),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const saved = (await response.json()) as XiaoConfig;
  if (saved.backgroundImagePath !== store.getSnapshot().backgroundImagePath) bgVersion++;
  store.set(saved);
}

/** 从失败的响应里提取 Host 返回的本地化错误文案；解析不到则回退到 HTTP 状态码。 */
async function errorText(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data && typeof data.error === 'string' && data.error.length > 0) return data.error;
  } catch {
    /* body 非 JSON，忽略 */
  }
  return 'HTTP ' + response.status;
}

/**
 * 上传背景图/视频到 Host，成功后把返回路径写入配置。
 * 返回 null 表示成功；否则返回用户可见的错误信息（来自 Host 的本地化 error 字段）。
 */
async function uploadBackground(store: ConfigStore, file: File): Promise<string | null> {
  const match = /\.([a-zA-Z0-9]+)$/.exec(file.name || '');
  const ext = match ? match[1]!.toLowerCase() : 'png';
  try {
    const response = await fetch('/xiao-theme/upload?ext=.' + encodeURIComponent(ext), {
      method: 'POST',
      headers: xiaoLangHeader(),
      body: file,
    });
    if (!response.ok) {
      console.error('[xiao-theme] upload failed:', response.status);
      return await errorText(response);
    }
    const data = (await response.json()) as { imagePath?: unknown; dynamic?: unknown };
    if (data && typeof data.imagePath === 'string' && data.imagePath.length > 0) {
      const patch: Partial<XiaoConfig> = { backgroundImagePath: data.imagePath };
      // Host 已自动识别是否为动态背景：动画 GIF / 视频 => dynamic=true；静态图/单帧 GIF => false。
      if (typeof data.dynamic === 'boolean') patch.backgroundDynamic = data.dynamic;
      await saveConfig(store, patch);
      return null;
    }
    return 'HTTP ' + response.status;
  } catch (error) {
    console.error('[xiao-theme] upload failed:', error);
    return error instanceof Error && error.message ? error.message : 'Upload failed';
  }
}

/** 上传头像图到 Host，成功后把返回的路径写入配置（头像无“动态背景”概念，只取 imagePath）。返回 null=成功，否则返回错误信息。 */
async function uploadAvatar(store: ConfigStore, file: File): Promise<string | null> {
  const match = /\.([a-zA-Z0-9]+)$/.exec(file.name || '');
  const ext = match ? match[1]!.toLowerCase() : 'png';
  try {
    const response = await fetch('/xiao-theme/upload?ext=.' + encodeURIComponent(ext) + '&kind=avatar', {
      method: 'POST',
      headers: xiaoLangHeader(),
      body: file,
    });
    if (!response.ok) {
      console.error('[xiao-theme] avatar upload failed:', response.status);
      return await errorText(response);
    }
    const data = (await response.json()) as { imagePath?: unknown };
    if (data && typeof data.imagePath === 'string' && data.imagePath.length > 0) {
      await saveConfig(store, { avatarPath: data.imagePath });
      return null;
    }
    return 'HTTP ' + response.status;
  } catch (error) {
    console.error('[xiao-theme] avatar upload failed:', error);
    return error instanceof Error && error.message ? error.message : 'Upload failed';
  }
}

/** 通用 JSON fetch：非 2xx 抛出带 error 文本的异常。 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init && init.headers ? init.headers : {}), ...xiaoLangHeader() } });
  if (!response.ok) {
    let msg = 'HTTP ' + response.status;
    try {
      const data = (await response.json()) as { error?: unknown };
      if (data && typeof data.error === 'string' && data.error.length > 0) msg = data.error;
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg);
  }
  return (await response.json()) as T;
}

// —— 主题管理 API ——
async function listThemes(): Promise<ThemeListResponse> {
  return fetchJson<ThemeListResponse>('/xiao-theme/themes', { cache: 'no-store' });
}
async function createTheme(name: string): Promise<ThemeSummary> {
  return fetchJson<ThemeSummary>('/xiao-theme/themes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
async function activateTheme(id: string): Promise<ThemeActivateResponse> {
  return fetchJson<ThemeActivateResponse>('/xiao-theme/themes-activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}
async function renameTheme(id: string, name: string): Promise<ThemeSummary> {
  return fetchJson<ThemeSummary>('/xiao-theme/themes-rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}
async function deleteTheme(id: string): Promise<{ activeThemeId: string }> {
  return fetchJson<{ activeThemeId: string }>('/xiao-theme/themes-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}
async function exportTheme(id: string): Promise<ThemeExport> {
  return fetchJson<ThemeExport>('/xiao-theme/themes-export?id=' + encodeURIComponent(id), { cache: 'no-store' });
}
async function importTheme(name: string, config: XiaoConfig): Promise<ThemeSummary> {
  return fetchJson<ThemeSummary>('/xiao-theme/themes-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, config }),
  });
}

// —— 角色空间（娱乐）API ——
/** GET /xiao-theme/roleplay：预设安装状态（设置页只读展示）。 */
interface RoleplayStatus {
  presetId: string;
  presetName: string;
  enabled: boolean;
  /** 预设当前是否挂了网络工具（Host 端 roleplayNetwork）。 */
  network?: boolean;
  installed: boolean;
  path: string;
}

async function getRoleplayStatus(): Promise<RoleplayStatus> {
  return fetchJson<RoleplayStatus>('/xiao-theme/roleplay', { cache: 'no-store' });
}
async function applyRoleplayPreset(): Promise<{ ok?: boolean; installed?: boolean }> {
  return fetchJson<{ ok?: boolean; installed?: boolean }>('/xiao-theme/roleplay-apply', { method: 'POST' });
}
async function openRoleplayFolder(): Promise<{ ok?: boolean; path?: string }> {
  return fetchJson<{ ok?: boolean; path?: string }>('/xiao-theme/roleplay-open-folder', { method: 'POST' });
}

/** 触发浏览器下载：导出主题为 .json 文件。 */
function downloadTheme(theme: ThemeExport): void {
  const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = (theme.name || 'xiao-theme') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
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
    // layer-3 原先是本主题的缺口（DSH 默认是不透明的静态中性色），better-sidebar 的卡片/标签条会用到它，
    // 不补的话右栏内部会留下一块「不跟主题、也不跟不透明度」的实色。透度取 1/2 之间（DSH 原层级顺序）。
    tokens['--dsw-alias-bg-layer-3'] = {
      light: rgba(lr, lg, lb, Math.max(light - 0.08, 0.22)),
      dark: rgba(dr, dg, db, Math.max(dark - 0.08, 0.22)),
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

/** 判断背景路径是否为视频（mp4/webm/mov/m4v）：视频背景即动态背景，用 <video> 元素渲染。 */
function isVideoPath(pathValue: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(pathValue || '');
}

/** 视频背景的首个用户交互时恢复声音的清理句柄（避免重复挂监听/泄漏）。 */
let bgVideoGestureCleanup: (() => void) | null = null;

/** 移除视频背景 <video> 元素并清理声音恢复监听。 */
function removeBgVideo(): void {
  const v = document.getElementById('xiao-theme-video') as HTMLVideoElement | null;
  if (v) {
    v.pause();
    v.remove();
  }
  if (bgVideoGestureCleanup) {
    bgVideoGestureCleanup();
    bgVideoGestureCleanup = null;
  }
}

/** 创建/更新视频背景 <video> 元素：铺满、循环、可选声音（默认静音以允许自动播放）。 */
function syncBgVideo(cfg: XiaoConfig, active: boolean): void {
  let v = document.getElementById('xiao-theme-video') as HTMLVideoElement | null;
  if (!active) {
    removeBgVideo();
    return;
  }
  if (!v) {
    v = document.createElement('video');
    v.id = 'xiao-theme-video';
    v.dataset.plugin = 'xiao-theme-ts';
    v.autoplay = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.style.position = 'fixed';
    v.style.inset = '0';
    v.style.width = '100%';
    v.style.height = '100%';
    v.style.objectFit = 'cover';
    v.style.zIndex = '-1';
    v.style.pointerEvents = 'none';
    document.body.appendChild(v);
  }
  const src = '/xiao-bg?p=' + encodeURIComponent(cfg.backgroundImagePath || '') + '&v=' + bgVersion;
  if (v.dataset.src !== src) {
    v.dataset.src = src;
    v.src = src;
  }
  const wantMuted = cfg.backgroundVideoAudio !== true;
  if (v.muted !== wantMuted) v.muted = wantMuted;
  const p = v.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // 自动播放带声音可能被浏览器拦截：先静音循环显示背景，等用户首次交互后再恢复声音。
      if (!v || document.getElementById('xiao-theme-video') !== v) return;
      if (!wantMuted && !bgVideoGestureCleanup) {
        if (v.muted === false) v.muted = true;
        void v.play().catch(() => {});
        const onGesture = (): void => {
          v!.muted = false;
          void v!.play().catch(() => {});
          if (bgVideoGestureCleanup) {
            bgVideoGestureCleanup();
            bgVideoGestureCleanup = null;
          }
        };
        bgVideoGestureCleanup = () => {
          window.removeEventListener('pointerdown', onGesture, true);
          window.removeEventListener('keydown', onGesture, true);
        };
        window.addEventListener('pointerdown', onGesture, true);
        window.addEventListener('keydown', onGesture, true);
      }
    });
  }
}

/**
 * 按配置应用 / 更新 / 移除整页磨砂背景。
 * 背景图铺在 body 上（一定可见），根框架强制半透明并加 backdrop-filter 模糊，
 * 让 body 背景图透出并产生磨砂效果——不依赖 z-index、不依赖主题服务。
 */
function syncBackground(cfg: XiaoConfig): void {
  const de = document.documentElement;
  const on = cfg.enabled !== false && cfg.backgroundEnabled !== false;
  const isVideoBg = cfg.backgroundDynamic === true && isVideoPath(cfg.backgroundImagePath || '');
  const frame = findFrameElement();
  if (!on) {
    de.classList.remove('xiao-bg-on');
    de.classList.remove('xiao-bg-dynamic');
    de.classList.remove('xiao-bg-video');
    removeBgVideo();
    de.style.removeProperty('--xiao-bg-img');
    de.style.removeProperty('--xiao-bg-blur');
    de.style.removeProperty('--xiao-bg-ovl');
    de.style.removeProperty('--xiao-bg-ovl-dark');
    de.style.removeProperty('--xiao-sidebar-ovl');
    de.style.removeProperty('--xiao-sidebar-ovl-dark');
    de.style.removeProperty('--xiao-sidebar-ovl-l1');
    de.style.removeProperty('--xiao-sidebar-ovl-l2');
    de.style.removeProperty('--xiao-sidebar-ovl-l3');
    de.style.removeProperty('--xiao-sidebar-ovl-dark-l1');
    de.style.removeProperty('--xiao-sidebar-ovl-dark-l2');
    de.style.removeProperty('--xiao-sidebar-ovl-dark-l3');
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
  // 动态背景：GIF 动图走 CSS background-image；视频走 <video> 元素（CSS 背景无法渲染视频）。
  de.classList.toggle('xiao-bg-dynamic', cfg.backgroundDynamic === true);
  de.classList.toggle('xiao-bg-video', isVideoBg);
  // 追加背景路径作为缓存指纹：背景图一变化 URL 就变，浏览器立即重新拉取，无需手动刷新页面。
  // 注意：视频背景不能作为 CSS background-image，改用 <video> 元素渲染（见上方 syncBgVideo），故不设该变量。
  if (isVideoBg) {
    de.style.removeProperty('--xiao-bg-img');
  } else {
    de.style.setProperty('--xiao-bg-img', 'url("/xiao-bg?p=' + encodeURIComponent(cfg.backgroundImagePath || '') + '&v=' + bgVersion + '")');
  }
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
  // 右栏面板内部的语义 token 覆盖值（见 XIAO_CSS 的 [data-sidebar-right-panel] 规则）：面板内的
  // tab 条/卡片走 --dsw-alias-bg-layer-1/2/3，比面板底色略实一点，既保住内容可读性，又让整体
  // 仍随侧栏不透明度单调变化（so=0 近全透、so=1 完全不透明）。不设 0.25 之类下限，否则拖到 0 也不透。
  de.style.setProperty('--xiao-sidebar-ovl-l1', rgba(lr, lg, lb, Math.min(so + 0.04, 1)));
  de.style.setProperty('--xiao-sidebar-ovl-l2', rgba(lr, lg, lb, Math.min(so + 0.08, 1)));
  de.style.setProperty('--xiao-sidebar-ovl-l3', rgba(lr, lg, lb, Math.min(so + 0.06, 1)));
  de.style.setProperty('--xiao-sidebar-ovl-dark-l1', rgba(dr, dg, db, Math.min(so + 0.04, 1)));
  de.style.setProperty('--xiao-sidebar-ovl-dark-l2', rgba(dr, dg, db, Math.min(so + 0.08, 1)));
  de.style.setProperty('--xiao-sidebar-ovl-dark-l3', rgba(dr, dg, db, Math.min(so + 0.06, 1)));
  // JS 兜底：若 CSS 选择器未命中根框架，直接给它设 inline 半透明 + 模糊
  if (frame) {
    const isDark = document.body.hasAttribute('data-ds-dark-theme');
    frame.style.backgroundColor = isDark ? rgba(dr, dg, db, ovl) : rgba(lr, lg, lb, ovl);
    frame.style.backgroundImage = 'none';
    frame.style.backdropFilter = 'blur(' + blur + 'px)';
    (frame.style as StyleWithWebkit).webkitBackdropFilter = 'blur(' + blur + 'px)';
  }
  // 视频背景：创建/更新 <video> 元素（铺满 + 循环 + 声音开关）。
  syncBgVideo(cfg, isVideoBg);
  // 强制重绘：背景挂在 background-attachment:fixed 下时，仅改 CSS 变量在某些浏览器不会刷新背景图层
  //（表现为必须整页刷新才生效）。这里显式移除再重加 xiao-bg-on 并触发一次重排，迫使浏览器重新取回并绘制新背景。
  de.classList.remove('xiao-bg-on');
  void de.offsetHeight;
  de.classList.add('xiao-bg-on');
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
function XiaoBadge({ avatarPath, title, subtitle }: { avatarPath: string; title: string; subtitle: string }): React.ReactElement {
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
        title: t('mascotDragOpen'),
      },
      React.createElement(
        'button',
        {
          className: 'xiao-tab',
          'aria-label': t('mascotShow'),
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
      title: t('mascotDragClose'),
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
        src: '/xiao-avatar.png?p=' + encodeURIComponent(avatarPath || '') + '&v=' + avatarVersion,
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
          'aria-label': t('mascotClose'),
          title: t('mascotCloseTip'),
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
    avatarPath: snapshot.avatarPath || CLIENT_DEFAULT_CONFIG.avatarPath,
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

/** 主题管理设置块：列出 / 新建 / 切换 / 重命名 / 删除 / 导入 / 导出（默认「魈」内置主题不可删除）。 */
function ThemeManager({ store }: { store: ConfigStore }): React.ReactElement {
  const [themes, setThemes] = React.useState<ThemeSummary[] | null>(null);
  const [activeId, setActiveId] = React.useState<string>('');
  const [newName, setNewName] = React.useState<string>('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState<string>('');
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = React.useState<boolean>(false);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const res = await listThemes();
      setThemes(res.themes);
      setActiveId(res.activeThemeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));

  const onActivate = async (id: string): Promise<void> => {
    if (busy || !id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await activateTheme(id);
      store.set(res.config); // 触发主题/背景重同步；提示词由 Host 端 syncVoice 重刷
      setActiveId(res.activeThemeId);
      await refresh();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  const onCreate = async (): Promise<void> => {
    if (busy) return;
    const name = newName.trim();
    if (!name) {
      setError(t('needThemeName'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createTheme(name);
      setNewName('');
      await refresh();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  const onRename = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    setEditingId(null);
    setEditingName('');
    if (busy || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await renameTheme(id, trimmed);
      await refresh();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  const onDelete = async (id: string): Promise<void> => {
    if (busy) return;
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      return;
    }
    setBusy(true);
    setError(null);
    const wasActive = activeId === id;
    try {
      const res = await deleteTheme(id);
      setPendingDeleteId(null);
      if (wasActive) {
        await loadConfig(store); // 删除的是当前主题 → 回落默认并重拉配置
        setActiveId(res.activeThemeId);
      }
      await refresh();
    } catch (e) {
      fail(e);
      setPendingDeleteId(null);
    }
    setBusy(false);
  };

  const onExport = async (id: string): Promise<void> => {
    setError(null);
    try {
      downloadTheme(await exportTheme(id));
    } catch (e) {
      fail(e);
    }
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { name?: unknown; config?: unknown };
      if (parsed === null || typeof parsed !== 'object') throw new Error(t('invalidImportFile'));
      const name =
        typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : '';
      if (parsed.config === null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
        throw new Error(t('importMissingConfig'));
      }
      await importTheme(name || t('importThemePrefix') + ((themes ? themes.length : 0) + 1), parsed.config as XiaoConfig);
      await refresh();
    } catch (ex) {
      fail(ex);
    }
  };

  const onRestoreDefaults = async (): Promise<void> => {
    if (busy) return;
    if (!pendingRestore) {
      setPendingRestore(true);
      return;
    }
    setBusy(true);
    setError(null);
    setPendingRestore(false);
    try {
      await restoreConfig(store);
      await refresh();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  const themeList = themes || [];
  const selectOptions = themeList.map((t2) =>
    React.createElement('option', { key: t2.id, value: t2.id }, t2.name + (t2.builtin ? t('builtinSuffix') : '')),
  );
  const themeRows = themeList.map((t2) => {
    const editing = editingId === t2.id;
    const nameContent = editing
      ? React.createElement('input', {
          className: 'xiao-settings-input',
          value: editingName,
          autoFocus: true,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditingName(e.target.value),
          onBlur: () => void onRename(t2.id, editingName),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void onRename(t2.id, editingName);
            else if (e.key === 'Escape') {
              setEditingId(null);
              setEditingName('');
            }
          },
        })
      : React.createElement('span', { className: 'xiao-settings-name' }, t2.name + (t2.active ? t('activeSuffix') : ''));
    return React.createElement(
      'div',
      { className: 'xiao-settings-row', key: t2.id },
      nameContent,
      editing
        ? null
        : React.createElement(
            'button',
            {
              className: 'xiao-settings-btn',
              type: 'button',
              disabled: busy,
              onClick: () => {
                setEditingId(t2.id);
                setEditingName(t2.name);
              },
            },
            t('rename'),
          ),
      React.createElement('button', { className: 'xiao-settings-btn', type: 'button', onClick: () => void onExport(t2.id) }, t('exportTheme')),
      t2.builtin
        ? React.createElement('button', { className: 'xiao-settings-btn', type: 'button', disabled: true, title: t('builtinNotDelete') }, t('deleteTheme'))
        : React.createElement(
            'button',
            {
              className: 'xiao-settings-btn' + (pendingDeleteId === t2.id ? ' xiao-settings-danger' : ''),
              type: 'button',
              disabled: busy,
              onClick: () => void onDelete(t2.id),
            },
            pendingDeleteId === t2.id ? t('confirmDelete') : t('deleteTheme'),
          ),
    );
  });

  return React.createElement(
    'div',
    { className: 'xiao-settings-section' },
    React.createElement('div', { className: 'xiao-settings-title' }, t('themeManager')),
    React.createElement('div', { className: 'xiao-settings-hint' }, t('themeManagerHint')),
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('currentTheme')),
      React.createElement(
        'select',
        {
          className: 'xiao-settings-select',
          value: activeId || '',
          disabled: busy || themeList.length === 0,
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void onActivate(e.target.value),
        },
        ...selectOptions,
      ),
    ),
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('saveAsNewTheme')),
      React.createElement('input', {
        className: 'xiao-settings-input',
        type: 'text',
        value: newName,
        placeholder: t('themeNamePlaceholder'),
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value),
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') void onCreate();
        },
      }),
      React.createElement('button', { className: 'xiao-settings-btn', type: 'button', disabled: busy, onClick: () => void onCreate() }, t('save')),
    ),
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('restoreDefault')),
      React.createElement(
        'button',
        {
          className: 'xiao-settings-btn' + (pendingRestore ? ' xiao-settings-danger' : ''),
          type: 'button',
          disabled: busy,
          onClick: () => void onRestoreDefaults(),
        },
        pendingRestore ? t('confirmRestore') : t('restoreCurrentTheme'),
      ),
    ),
    ...(pendingRestore
      ? [
          React.createElement(
            'div',
            { className: 'xiao-settings-warn' },
            t('restoreWarn'),
          ),
        ]
      : []),
    ...themeRows,
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('importTheme')),
      React.createElement('input', {
        className: 'xiao-settings-file',
        type: 'file',
        accept: '.json,application/json',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => void onImportFile(e),
      }),
      React.createElement('button', { className: 'xiao-settings-btn', type: 'button', onClick: () => void refresh() }, t('refresh')),
    ),
    ...(error ? [React.createElement('div', { className: 'xiao-settings-hint' }, error)] : []),
  );
}
/** 设置页组件：提示词（语言/自定义/恢复默认）+ 头像 + 磨砂背景（开关/路径/上传/参数）。 */
/** 把字节数格式化为可读大小。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 判断上传项是否为视频（用于缩略图渲染）：视频用 <video> 元素，其它用 <img>。 */
function isUploadVideo(item: UploadEntry): boolean {
  return item.isDynamic === true && /\.(mp4|webm|mov|m4v)$/i.test(item.ext || '');
}

/**
 * 上传选择器弹窗：列出已上传的背景/头像，可选中复用（写入当前主题配置），也可在窗口内上传并自动选中。
 * 提供「打开上传文件夹」让用户在系统文件管理器里直接增删改。全程不自动删除任何文件。
 */
function UploadPicker({
  kind,
  store,
  onClose,
}: {
  kind: 'bg' | 'avatar';
  store: ConfigStore;
  onClose: () => void;
}): React.ReactElement {
  const [items, setItems] = React.useState<UploadEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState<boolean>(false);
  const [using, setUsing] = React.useState<boolean>(false);
  const [opening, setOpening] = React.useState<boolean>(false);
  const [folderHint, setFolderHint] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const accept =
    kind === 'avatar'
      ? 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml'
      : 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/webm';
  const configKey = kind === 'avatar' ? 'avatarPath' : 'backgroundImagePath';
  const dynamicKey = kind === 'avatar' ? null : 'backgroundDynamic';

  /** 从 Host 拉取上传列表；失败时设 error 并返回 []。 */
  const loadList = React.useCallback(async (): Promise<UploadEntry[]> => {
    try {
      const response = await fetch('/xiao-theme/uploads?kind=' + kind, { cache: 'no-store', headers: xiaoLangHeader() });
      if (!response.ok) {
        setError('HTTP ' + response.status);
        return [];
      }
      const data = (await response.json()) as UploadListResponse;
      return data.uploads || [];
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [kind]);

  /** 应用列表并保持选中态（选中项消失则回落第一个）。 */
  const applyList = React.useCallback((list: UploadEntry[]): void => {
    setItems(list);
    setSelected((prev) => (prev && list.some((u) => u.name === prev) ? prev : list[0] ? list[0].name : null));
  }, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    setError(null);
    applyList(await loadList());
  }, [loadList, applyList]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const thumbUrl = (item: UploadEntry): string =>
    '/xiao-theme/uploads-file?name=' + encodeURIComponent(item.name) + '&v=' + item.mtime;

  /** 选中并写回当前主题背景/头像配置。 */
  const useSelected = async (): Promise<void> => {
    const item = items && items.find((u) => u.name === selected);
    if (!item || using) return;
    setUsing(true);
    try {
      const patch: Partial<XiaoConfig> = { [configKey]: item.path };
      if (kind === 'bg' && dynamicKey !== null) patch[dynamicKey] = item.isDynamic;
      await saveConfig(store, patch);
      onClose();
    } finally {
      setUsing(false);
    }
  };

  /** 窗口内上传：成功后刷新列表 + 自动选中刚上传的文件。 */
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const err = kind === 'avatar' ? await uploadAvatar(store, file) : await uploadBackground(store, file);
      if (err !== null) {
        setError(t('uploadsUploadFailed') + ': ' + err);
      } else {
        const list = await loadList();
        applyList(list);
        const currentPath = store.getSnapshot()[configKey];
        const match = list.find((u) => u.path === currentPath);
        if (match) setSelected(match.name);
      }
    } finally {
      setUploading(false);
    }
  };

  const onOpenFolder = async (): Promise<void> => {
    setOpening(true);
    try {
      const response = await fetch('/xiao-theme/open-uploads', { method: 'POST', headers: xiaoLangHeader() });
      const data = (await response.json()) as { ok?: boolean; path?: string };
      if (data && data.ok) {
        setFolderHint(t('uploadsFolderOpened'));
      } else {
        setFolderHint(t('uploadsFolderFailed') + ' ' + (data && data.path ? data.path : ''));
      }
    } catch {
      setFolderHint(t('uploadsFolderFailed'));
    } finally {
      setOpening(false);
    }
  };

  const listBody =
    items === null
      ? React.createElement('div', { className: 'xiao-upload-empty' }, t('uploadsFetchError'))
      : items.length === 0
        ? React.createElement('div', { className: 'xiao-upload-empty' }, t('uploadsEmpty'))
        : React.createElement(
            'div',
            { className: 'xiao-upload-list' },
            items.map((item) =>
              React.createElement(
                'div',
                {
                  className: 'xiao-upload-item' + (selected === item.name ? ' xiao-upload-item-sel' : ''),
                  key: item.name,
                  onClick: () => setSelected(item.name),
                },
                isUploadVideo(item)
                  ? React.createElement('video', {
                      className: 'xiao-upload-thumb',
                      src: thumbUrl(item),
                      muted: true,
                      playsInline: true,
                      preload: 'metadata',
                    })
                  : React.createElement('img', { className: 'xiao-upload-thumb', src: thumbUrl(item) }),
                React.createElement(
                  'div',
                  { className: 'xiao-upload-info' },
                  React.createElement('div', { className: 'xiao-upload-name' }, item.name),
                  React.createElement('div', { className: 'xiao-upload-meta' }, formatFileSize(item.size) + ' · ' + (item.ext || '')),
                  React.createElement(
                    'div',
                    { className: 'xiao-upload-ref' },
                    item.active ? React.createElement('span', { className: 'xiao-upload-cur' }, t('uploadsCurrent')) : null,
                    item.usedBy.length > 0 ? t('uploadsUsedBy') + ': ' + item.usedBy.join(', ') : null,
                  ),
                ),
              ),
            ),
          );

  return React.createElement(
    'div',
    { className: 'xiao-upload-modal' },
    React.createElement(
      'div',
      { className: 'xiao-upload-panel' },
      React.createElement('div', { className: 'xiao-upload-head' }, t('uploadsTitle')),
      error ? React.createElement('div', { className: 'xiao-settings-warn' }, error) : null,
      listBody,
      folderHint ? React.createElement('div', { className: 'xiao-settings-hint' }, folderHint) : null,
      React.createElement('input', {
        ref: fileRef,
        type: 'file',
        accept,
        style: { display: 'none' },
        onChange: onUpload,
      }),
      React.createElement(
        'div',
        { className: 'xiao-upload-foot' },
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            disabled: uploading,
            onClick: () => {
              if (fileRef.current) fileRef.current.click();
            },
          },
          uploading ? t('uploadsUploading') : t('uploadsUpload'),
        ),
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            disabled: opening,
            onClick: () => void onOpenFolder(),
          },
          t('uploadsOpenFolder'),
        ),
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            disabled: using || selected === null,
            onClick: () => void useSelected(),
          },
          t('uploadsUse'),
        ),
        React.createElement(
          'button',
          { className: 'xiao-settings-btn', type: 'button', onClick: onClose },
          t('uploadsClose'),
        ),
      ),
    ),
  );
}

/**
 * 角色空间（娱乐）设置块：一键开关 + 角色 system prompt + 预设安装状态。
 * 与上方「语气」分组彻底分开：这里产出的是一个独立 agent preset，永不进工作会话。
 */
function RoleplayGroup({ cfg, store }: { cfg: XiaoConfig; store: ConfigStore }): React.ReactElement {
  // masterOn = 「启用魈主题」总开关；featureOn = 角色空间自己的开关（用户的选择，不受总开关影响）；
  // active = 两者同时开才真正生效（Host 端同判断，总开关关闭时会移除预设）。
  const masterOn = cfg.enabled !== false;
  const featureOn = cfg.roleplayEnabled === true;
  const enabled = masterOn && featureOn;
  const persona = cfg.roleplayPersona || '';
  const [status, setStatus] = React.useState<RoleplayStatus | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [hint, setHint] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setStatus(await getRoleplayStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh, enabled, persona]);

  const onApply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      await applyRoleplayPreset();
      await refresh();
      setHint(t('roleplayApplied'));
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const onOpenFolder = async (): Promise<void> => {
    setHint(null);
    try {
      const data = await openRoleplayFolder();
      setHint(data.ok ? t('uploadsFolderOpened') : t('uploadsFolderFailed') + ' ' + (data.path || ''));
    } catch {
      setHint(t('uploadsFolderFailed'));
    }
  };

  const statusText =
    status === null
      ? t('roleplayStatusUnknown')
      : !masterOn
        ? t('roleplayStatusMasterOff')
        : !featureOn
          ? t('roleplayStatusOff')
          : (status.installed ? t('roleplayStatusInstalled') : t('roleplayStatusMissing')) +
            ' · ' + status.presetName + ' · ' + status.path;

  return React.createElement(
    'div',
    { className: 'xiao-settings-section' },
    React.createElement('div', { className: 'xiao-settings-title' }, t('roleplaySection')),
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('roleplayEnable')),
      React.createElement('input', {
        type: 'checkbox',
        // 显示的是「用户自己的选择」，而不是合成结果：总开关关掉时不该把角色开关也画成关闭。
        checked: featureOn,
        disabled: !masterOn,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          void saveConfig(store, { roleplayEnabled: e.target.checked });
        },
      }),
    ),
    React.createElement(
      'div',
      { className: 'xiao-settings-row' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('roleplayNetwork')),
      React.createElement('input', {
        type: 'checkbox',
        // 网络是运行时能力：只有角色空间真正生效（总开关 + 角色开关）时才可改。
        checked: cfg.roleplayNetwork === true,
        disabled: !enabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          void saveConfig(store, { roleplayNetwork: e.target.checked });
        },
      }),
    ),
    React.createElement('div', { className: 'xiao-settings-hint' }, t('roleplayNetworkHint')),
    React.createElement(
      'div',
      { className: 'xiao-settings-row xiao-settings-row-top' },
      React.createElement('label', { className: 'xiao-settings-label' }, t('roleplayPersona')),
      React.createElement('textarea', {
        className: 'xiao-settings-textarea',
        defaultValue: persona,
        key: persona,
        rows: 7,
        disabled: !enabled,
        placeholder: t('roleplayPersonaPlaceholder'),
        onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => {
          const next = e.target.value;
          if (next !== persona) void saveConfig(store, { roleplayPersona: next });
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
          disabled: busy || !enabled,
          onClick: () => void onApply(),
        },
        t('roleplayApply'),
      ),
      React.createElement(
        'button',
        {
          className: 'xiao-settings-btn',
          type: 'button',
          disabled: !enabled,
          onClick: () => void saveConfig(store, { roleplayPersona: '' }),
        },
        t('roleplayResetPersona'),
      ),
      React.createElement(
        'button',
        { className: 'xiao-settings-btn', type: 'button', onClick: () => void onOpenFolder() },
        t('roleplayOpenFolder'),
      ),
    ),
    React.createElement('div', { className: 'xiao-settings-hint' }, statusText),
    React.createElement('div', { className: 'xiao-settings-hint' }, t('roleplayHint')),
    React.createElement('div', { className: 'xiao-settings-hint' }, t('roleplayHintWork')),
    hint ? React.createElement('div', { className: 'xiao-settings-hint' }, hint) : null,
  );
}

function XiaoSettingsPage({ store }: { store: ConfigStore }): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<XiaoConfig>(() => store.getSnapshot());
  React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
  const [pickerKind, setPickerKind] = React.useState<'bg' | 'avatar' | null>(null);
  const cfg = snapshot;
  const enabled = cfg.enabled !== false;
  const voiceEnabled = cfg.voiceEnabled !== false;
  const avatarPath = cfg.avatarPath || CLIENT_DEFAULT_CONFIG.avatarPath;
  const voiceLanguage = cfg.voiceLanguage === 'zh' ? 'zh' : 'en';
  const voicePrompt = cfg.voicePrompt || '';
  const bgEnabled = cfg.backgroundEnabled !== false;
  const bgPath = cfg.backgroundImagePath || CLIENT_DEFAULT_CONFIG.backgroundImagePath;
  // 当前背景是否为视频（在下方显示「视频背景声音」开关；仅视频背景可播声音）。
  const isVideoBg = cfg.backgroundDynamic === true && isVideoPath(bgPath);
  const themeColor =
    typeof cfg.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.themeColor)
      ? cfg.themeColor
      : DEFAULT_THEME_COLOR;

  return React.createElement(
    'div',
    { className: 'xiao-settings' },
    React.createElement(ThemeManager, { store }),
    // —— 总开关 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, t('themeTitle')),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, t('enableTheme')),
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
        React.createElement('label', { className: 'xiao-settings-label' }, t('themeColor')),
        React.createElement('input', {
          className: 'xiao-settings-color',
          type: 'color',
          value: themeColor,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            void saveConfig(store, { themeColor: e.target.value });
          },
        }),
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            onClick: () => void saveConfig(store, { themeColor: CLIENT_DEFAULT_CONFIG.themeColor }),
          },
          t('restoreThemeColor'),
        ),
      ),
    ),

    // —— 提示词 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, t('voiceSection')),
      React.createElement('div', { className: 'xiao-settings-hint' }, t('voiceSectionHint')),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, t('injectVoice')),
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
        React.createElement('label', { className: 'xiao-settings-label' }, t('templateLang')),
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
        React.createElement('label', { className: 'xiao-settings-label' }, t('customPrompt')),
        React.createElement('textarea', {
          className: 'xiao-settings-textarea',
          defaultValue: voicePrompt,
          key: voicePrompt,
          rows: 5,
          disabled: !voiceEnabled,
          placeholder: t('promptPlaceholder'),
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
          t('restorePrompt'),
        ),
      ),
    ),

    // —— 角色空间（娱乐）——
    React.createElement(RoleplayGroup, { cfg, store }),

    // —— 吉祥物 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, t('mascotSection')),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, t('avatarPath')),
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
        React.createElement('button', { className: 'xiao-settings-btn', type: 'button', onClick: () => setPickerKind('avatar') }, t('uploadAvatar')),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, t('titleField')),
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
        React.createElement('label', { className: 'xiao-settings-label' }, t('subtitleField')),
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
                avatarPath: CLIENT_DEFAULT_CONFIG.avatarPath,
                mascotTitle: CLIENT_DEFAULT_CONFIG.mascotTitle,
                mascotSubtitle: CLIENT_DEFAULT_CONFIG.mascotSubtitle,
              }),
          },
          t('restoreMascot'),
        ),
      ),
    ),

    // —— 磨砂背景 ——
    React.createElement(
      'div',
      { className: 'xiao-settings-section' },
      React.createElement('div', { className: 'xiao-settings-title' }, t('bgSection')),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('label', { className: 'xiao-settings-label' }, t('enableBg')),
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
        React.createElement('label', { className: 'xiao-settings-label' }, t('bgPath')),
        React.createElement('input', {
          className: 'xiao-settings-input',
          type: 'text',
          defaultValue: bgPath,
          key: bgPath,
          onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
            const next = e.target.value.trim();
            if (next.length > 0) {
              // GIF/视频即动态背景：手动填 .gif/.mp4/.webm/.mov/.m4v 路径时自动视为动态背景；其余按静态背景。
              const isDynamic = /\.(gif|mp4|webm|mov|m4v)$/i.test(next);
              void saveConfig(store, { backgroundImagePath: next, backgroundDynamic: isDynamic });
            }
          },
        }),
      ),
      React.createElement(
        'div',
        { className: 'xiao-settings-row' },
        React.createElement('button', { className: 'xiao-settings-btn', type: 'button', onClick: () => setPickerKind('bg') }, t('uploadBg')),
      ),
      isVideoBg &&
        React.createElement(
          'div',
          { className: 'xiao-settings-row' },
          React.createElement('label', { className: 'xiao-settings-label' }, t('videoAudio')),
          React.createElement('input', {
            type: 'checkbox',
            checked: cfg.backgroundVideoAudio === true,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
              void saveConfig(store, { backgroundVideoAudio: e.target.checked });
            },
          }),
        ),
      React.createElement(RangeRow, {
        label: t('blurStrength'),
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
        label: t('uiOpacity'),
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
        label: t('sidebarOpacity'),
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
                backgroundDynamic: false,
                backgroundBlur: 22,
                panelOpacity: 0.5,
                sidebarOpacity: 0.85,
              }),
          },
          t('useStaticDefault'),
        ),
        React.createElement(
          'button',
          {
            className: 'xiao-settings-btn',
            type: 'button',
            onClick: () =>
              void saveConfig(store, {
                backgroundEnabled: true,
                backgroundImagePath: 'resource/xiao_dynamic.gif',
                backgroundDynamic: true,
              }),
          },
          t('useDynamicExample'),
        ),
      ),
    ),

    React.createElement(
      'div',
      { className: 'xiao-settings-hint' },
      t('settingsHint'),
    ),
    pickerKind !== null
      ? React.createElement(UploadPicker, { kind: pickerKind, store, onClose: () => setPickerKind(null) })
      : null,
  );
}

const XIAO_CSS: string[] = [
  'html.xiao-bg-on,html.xiao-bg-on body{background-color:transparent!important;}',
  'html.xiao-bg-on body{background-image:var(--xiao-bg-img),linear-gradient(135deg,var(--xiao-grad-a),var(--xiao-theme-color) 55%,var(--xiao-grad-b))!important;background-color:transparent!important;background-attachment:fixed!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;}',
  // 动态背景（GIF 动图）：覆盖为纯动图（去掉渐变着色），让动画按原色铺满并随页面播放；static 维持上方「URL+渐变」磨砂处理。
  'html.xiao-bg-on.xiao-bg-dynamic body{background-image:var(--xiao-bg-img)!important;}',
  // 视频背景：body 背景图置空，仅留 <video> 元素（fixed 垫底）作为视觉层；磨砂层仍由 #root>div 透出并模糊。
  'html.xiao-bg-on.xiao-bg-video body{background-image:none!important;}',
  'html.xiao-bg-on body>#root>div{background:var(--xiao-bg-ovl)!important;background-image:none!important;-webkit-backdrop-filter:blur(var(--xiao-bg-blur));backdrop-filter:blur(var(--xiao-bg-blur));}',
  'html.xiao-bg-on body[data-ds-dark-theme]>#root>div{background:var(--xiao-bg-ovl-dark)!important;}',
  // 左侧：DSH 自带侧栏，用「类名后缀」属性选择器（不依赖被哈希的类名前缀），浅色/深色各一变量。
  // detailsCol 是 0.1.5 之前的右栏列名，保留仅供未升级 DSH 的用户；0.1.5-rc.1 起它已不存在。
  'html.xiao-bg-on [class$="sidebarCol"],[class$="detailsCol"]{background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [class$="sidebarCol"],body[data-ds-dark-theme] [class$="detailsCol"]{background:var(--xiao-sidebar-ovl-dark)!important;}',
  // 右侧：现 DSH 原生右栏面板（dsh-client-ui-sidebar-right 的 .panel，稳定锚点 data-sidebar-right-panel）。
  // better-sidebar ≥0.19 不再自绘右栏，而是把每个 tab 注册进这块原生面板（ctx.sidebarRight /
  // sidebar.right.pane.tab），所以这一条同时覆盖「DSH 自带右栏」与「better-sidebar 的新右栏」。
  // 除面板底色外，还在该子树内覆盖语义背景 token：better-sidebar 的 CSS 模块（tab 条、卡片、编辑器、
  // 文件树…）大量消费 --dsw-alias-bg-layer-1/2/3，只改面板底色的话内部表面仍是不透明的。
  // 浮窗层（data-sidebar-right-float-host）portal 到 body，不在此子树内，故不受影响。
  'html.xiao-bg-on [data-sidebar-right-panel]{background:var(--xiao-sidebar-ovl)!important;--dsw-alias-bg-base:var(--xiao-sidebar-ovl);--dsw-alias-bg-layer-1:var(--xiao-sidebar-ovl-l1);--dsw-alias-bg-layer-2:var(--xiao-sidebar-ovl-l2);--dsw-alias-bg-layer-3:var(--xiao-sidebar-ovl-l3);}',
  'html.xiao-bg-on body[data-ds-dark-theme] [data-sidebar-right-panel]{background:var(--xiao-sidebar-ovl-dark)!important;--dsw-alias-bg-base:var(--xiao-sidebar-ovl-dark);--dsw-alias-bg-layer-1:var(--xiao-sidebar-ovl-dark-l1);--dsw-alias-bg-layer-2:var(--xiao-sidebar-ovl-dark-l2);--dsw-alias-bg-layer-3:var(--xiao-sidebar-ovl-dark-l3);}',
  // 旧版 better-sidebar（<0.19）自绘的右侧面板：保留 data 属性锚点做向后兼容。
  // ⚠️ 新版把 data-dsh-panel 挪到了「底部工作台面板」上（同一元素还带 data-dsh-bottom-panel），
  // 用 :not() 把它摘掉——它压在对话区上，涂透会透出对话文字。没装该插件时匹配不到，天然无副作用。
  'html.xiao-bg-on [data-dsh-panel]:not([data-dsh-bottom-panel]){background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on [data-dsh-panel]:not([data-dsh-bottom-panel]) [data-dsh-pane]{background:var(--xiao-sidebar-ovl)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [data-dsh-panel]:not([data-dsh-bottom-panel]){background:var(--xiao-sidebar-ovl-dark)!important;}',
  'html.xiao-bg-on body[data-ds-dark-theme] [data-dsh-panel]:not([data-dsh-bottom-panel]) [data-dsh-pane]{background:var(--xiao-sidebar-ovl-dark)!important;}',
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
  '.xiao-settings-name{font-size:14px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.xiao-settings-danger{border-color:var(--dsw-alias-state-error-primary)!important;color:var(--dsw-alias-state-error-primary)!important;}',
  '.xiao-settings-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);line-height:1.6;padding:2px 0;}',
  '.xiao-settings-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
  '.xiao-upload-modal{position:fixed;inset:0;z-index:2147483600;background:rgba(10,24,20,0.55);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,sans-serif;}',
  '.xiao-upload-panel{width:min(560px,92vw);max-height:78vh;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-shadow:0 16px 50px rgba(0,0,0,0.4);overflow:hidden;}',
  '.xiao-upload-head{font-size:15px;font-weight:700;color:var(--dsw-alias-brand-primary);letter-spacing:1px;}',
  '.xiao-upload-list{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow-y:auto;}',
  '.xiao-upload-item{display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer;}',
  '.xiao-upload-item:hover{border-color:var(--dsw-alias-brand-primary);}',
  '.xiao-upload-item-sel{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
  '.xiao-upload-thumb{width:56px;height:56px;object-fit:cover;border-radius:8px;flex:none;background:var(--dsw-alias-bg-overlay);}',
  '.xiao-upload-info{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}',
  '.xiao-upload-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.xiao-upload-meta{font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.xiao-upload-ref{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
  '.xiao-upload-cur{font-size:11px;color:var(--dsw-alias-state-success-primary);}',
  '.xiao-upload-empty{font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center;padding:24px 8px;line-height:1.6;}',
  '.xiao-upload-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;}',
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
      de.classList.remove('xiao-bg-dynamic');
      de.classList.remove('xiao-bg-video');
      removeBgVideo();
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
  // settings.section 标题需跟随 DSH 界面语言：用 slots.inject 声明该 slot（必须，否则 DSH 会报“slot 未声明”崩溃），
  // 并在语言变化（<html lang> 更新）时 dispose 旧 inject + 重 inject 以更新 label。
  const localeSvc = ctx.get('locale');
  let settingsInject: (() => void) | null = null;
  const sectionLabel = (): string => {
    const active = localeSvc ? localeSvc.getLocale().active : '';
    if (active === 'zh') return STR.themeTitle!.zh;
    if (active === 'en') return STR.themeTitle!.en;
    return t('themeTitle');
  };
  const registerSettings = (): void => {
    try {
      if (settingsInject !== null) {
        settingsInject();
        settingsInject = null;
      }
      const d = slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'xiao-theme-ts', order: 100, label: sectionLabel() }, () =>
          React.createElement(XiaoSettingsPage, { store }),
        ),
      );
      settingsInject = typeof d === 'function' ? d : null;
    } catch (error) {
      console.error('[xiao-theme] settings.section register failed:', error);
    }
  };
  // 语言变化（DSH 更新 <html lang>）时重注册；覆盖初始时序（lang 尚未设置）与后续切换。
  const langObserver = new MutationObserver(() => registerSettings());
  langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  registerSettings();
  ctx.effect(
    () => () => {
      langObserver.disconnect();
      if (settingsInject !== null) settingsInject();
    },
    'xiao-theme: settings section locale sync',
  );
}

export { inject, apply };
export default { inject, apply } satisfies ClientPlugin;
