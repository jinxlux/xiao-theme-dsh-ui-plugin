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
  /** 磨砂背景模糊强度（px）。 */
  backgroundBlur: number;
  /** 浅色模式遮罩透明度。 */
  backgroundOpacity: number;
  /** 深色模式遮罩透明度。 */
  backgroundDarkOpacity: number;
}
