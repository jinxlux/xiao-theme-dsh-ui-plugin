import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 魈主题 —— 宿主（Host）半强类型契约。
 * 只声明插件实际用到的 DSH 服务面，用于在编译期捕获方法名/字段名笔误。
 * 运行时的真实服务由 DSH 进程注入（`ctx.inject`），此处仅做类型镜像。
 */

/** systemPrompt.service.section 的注册选项。 */
export interface SystemPromptSectionOptions {
  name: string;
  order: number;
  text: string;
}

/** DSH 的 systemPrompt 服务（@deepseek-ai/dsh-system-prompt）。 */
export interface SystemPromptService {
  /** 向系统提示注入一段区块，返回一个卸载函数。 */
  section(options: SystemPromptSectionOptions): () => void;
}

/** webServer 路由的 handler 签名。 */
export type WebRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** webServer.register 的 route 注册选项（本插件只用 exact 匹配）。 */
export interface WebRouteRegistration {
  kind: 'exact';
  path: string;
  handler: WebRouteHandler;
}

/** DSH 的 webServer 服务（@deepseek-ai/dsh-host-webserver）。 */
export interface WebServerService {
  /** 注册一条 HTTP 路由，返回一个卸载函数。 */
  register(options: WebRouteRegistration): () => void;
}

/** 一个 Agent 预设的声明（@deepseek-ai/dsh-agent-preset 的 `config` 形态）。 */
export interface AgentPresetDefinition {
  /** 预设 id（须匹配 [a-z0-9][a-z0-9-]*）。 */
  id: string;
  /** 选择器里的显示名。 */
  name?: string;
  /** 选择器里的说明文字。 */
  description?: string;
  /** 排序（越小越前）。 */
  order?: number;
  /** 该预设挂载的 Cordis 行（`{ id, name, config }`，与 YAML 形态一致）。 */
  plugins: unknown[];
}

/**
 * DSH 的 Agent 预设注册表（0.1.7 起；@deepseek-ai/dsh-agent-preset-registry，服务名 `agentPresets`）。
 * ≤0.1.6 没有这个服务，注入回调不会触发 —— 那一代改走 <DSH_HOME>/.agent-presets 目录。
 */
export interface AgentPresetsService {
  /**
   * 注册并立即挂载一个预设定义（id 重复会抛错）。
   * @returns 异步卸载函数：释放该预设的挂载并把它从选择器里摘掉。
   * ⚠️ **可选**：0.1.5 / 0.1.6 也有一个同名服务 `agentPresets`，但那是「目录 roster」
   * （只有 list / read / copy / deletePreset / select），没有 register。调用前必须先判能力，
   * 否则那一代会被这个 TypeError 打断、连文件路线都走不到（两个版本都要能用）。
   */
  register?(definition: AgentPresetDefinition): Promise<() => Promise<void>>;
}

/** 宿主插件依赖到的服务：key → 服务类型。 */
export interface HostServices {
  systemPrompt: SystemPromptService;
  webServer: WebServerService;
  agentPresets: AgentPresetsService;
}

/** `ctx.inject(...)` 回调收到的子上下文：按 key 暴露服务，并带 `effect` 生命周期。 */
export type InjectSub<Ctx extends object, K extends keyof Ctx> = {
  [k in K]: Ctx[k];
} & {
  /** 注册一个副作用/清理函数，返回一个卸载函数。 */
  effect(fn: () => void | (() => void), label?: string): () => void;
};

/** Cordis 插件宿主上下文的最小类型面（只列出插件用到的成员）。 */
export interface HostCtx {
  /** 按服务名注入，获得注入子上下文。 */
  inject<K extends keyof HostServices>(
    keys: readonly K[],
    hook: (sub: InjectSub<HostServices, K>) => void,
  ): void;
  /** 可选读取一个服务（可能为 undefined）。 */
  get<S extends keyof HostServices>(service: S): HostServices[S] | undefined;
  /** 注册一个副作用/清理函数。 */
  effect(fn: () => void | (() => void), label?: string): void;
}
