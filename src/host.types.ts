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

/** 宿主插件依赖到的服务：key → 服务类型。 */
export interface HostServices {
  systemPrompt: SystemPromptService;
  webServer: WebServerService;
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
