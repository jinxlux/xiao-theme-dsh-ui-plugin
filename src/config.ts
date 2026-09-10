/**
 * 魈主题 —— 配置结构与类型（Host / Client 共享的强类型契约）。
 * 运行时默认值由 Host（src/index.ts 的 HOST_DEFAULT_CONFIG）与 Client
 * （src/client.ts 的 CLIENT_DEFAULT_CONFIG）各自以 `XiaoConfig` 类型自包含地定义，
 * 以保证各自的构建产物不依赖相对模块；字段校验由 `XiaoConfig` 在编译期强制执行。
 */

export type VoiceLanguage = 'en' | 'zh';

/** 魈主题的持久化配置。 */
export interface XiaoConfig {
  /** 总开关：关掉后不注入提示词、头像与背景全部失效。 */
  enabled: boolean;
  /** 是否注入魈式语气（提示词）。须在 enabled=true 时生效；默认 true。 */
  voiceEnabled: boolean;
  /** 头像图片路径（绝对路径，如 D:/test/avatar.png）。 */
  avatarPath: string;
  /** 提示词模板语言：en / zh。 */
  voiceLanguage: VoiceLanguage;
  /** 自定义提示词；非空时优先于所选语言模板。 */
  voicePrompt: string;
  /** 是否启用磨砂背景。 */
  backgroundEnabled: boolean;
  /** 背景图路径：支持相对插件根（resource/avatar.png）或绝对路径。 */
  backgroundImagePath: string;
  /** 是否为动态背景（gif 动图 / 视频）：true 表示背景图是动态 GIF 或视频，按动态背景渲染。 */
  backgroundDynamic: boolean;
  /** 视频背景是否播放声音（仅当背景为视频时生效；默认静音，因浏览器要求自动播放需 muted）。 */
  backgroundVideoAudio: boolean;
  /** 磨砂背景模糊强度（px）。 */
  backgroundBlur: number;
  /**
   * 界面不透明度（0–1）：作用于 sidebar / 面板 / 内容层的底色，浅色与深色主题统一生效。
   * 数值越大界面越不透明；为了「背景图始终可见」，最大只允许到 0.9（恒留 ≥10% 背景透出）。
   */
  panelOpacity: number;
  /**
   * 侧栏不透明度（0–1）：专门统管左右两侧 sidebar 的底色，浅色与深色主题统一生效。
   * 与 panelOpacity 独立，且允许到 1.0（完全 100% 不透明，不受面板 0.9 封顶限制）。
   */
  sidebarOpacity: number;
  /**
   * 主题主色（hex，如 #2E8B72）：青玉/翠青整套色板（背景、边框、品牌色、侧栏、背景渐变）都从
   * 这个主色派生。默认魈的青玉绿；用户可经设置页圆形色盘任意自定义。
   */
  themeColor: string;
  /** 吉祥物徽章标题（默认「靖妖傩舞」）。 */
  mascotTitle: string;
  /** 吉祥物徽章副标（默认「别挡路」）。 */
  mascotSubtitle: string;
}

/** 主题列表里的一条摘要（不含完整配置）。 */
export interface ThemeSummary {
  id: string;
  name: string;
  /** 内置主题（默认「魈」）：不可删除。 */
  builtin: boolean;
  /** 是否为当前激活主题。 */
  active: boolean;
}

/** GET /xiao-theme/themes 的响应：当前主题 id + 主题摘要列表。 */
export interface ThemeListResponse {
  activeThemeId: string;
  themes: ThemeSummary[];
}

/** POST /xiao-theme/themes-activate 的响应：切换后返回新当前主题的完整配置。 */
export interface ThemeActivateResponse {
  activeThemeId: string;
  config: XiaoConfig;
}

/** 主题导出格式：一份完整配置 + 标识信息（供一键导入/导出）。 */
export interface ThemeExport {
  framework: 'xiao-theme-ts';
  version: number;
  name: string;
  config: XiaoConfig;
}

/** 上传目录里的一条资产（背景图/头像，供上传选择器列出与复用）。 */
export interface UploadEntry {
  /** 目录内文件名（如 bg-1700000000000.png）。 */
  name: string;
  /** 用途：背景图 / 头像（按文件名前缀 bg- / avatar- 推断）。 */
  kind: 'bg' | 'avatar';
  /** 绝对路径（/ 分隔，可直接写入背景/头像配置）。 */
  path: string;
  /** 字节数。 */
  size: number;
  /** 最后修改时间（ms）。 */
  mtime: number;
  /** 扩展名（.png / .gif / .mp4 …）。 */
  ext: string;
  /** 是否为动态背景（动画 GIF / 视频）：视频或动画 GIF 为 true，静态图/单帧 GIF 为 false。 */
  isDynamic: boolean;
  /** 引用此资产的活主题名列表（save-as-new 会让多个主题指向同一份）。 */
  usedBy: string[];
  /** 是否被当前活动主题引用。 */
  active: boolean;
}

/** GET /xiao-theme/uploads 的响应：上传资产列表（按 mtime 倒序）。 */
export interface UploadListResponse {
  uploads: UploadEntry[];
}
