/**
 * 魈主题 —— 客户端（Client）半强类型契约（ModuleLoader 模式下用于编译期捕获接口笔误）。
 * 运行时的 slots / theme 服务由 DSH 客户端运行时注入。react 经 ModuleLoader 的 `require` 提供。
 */
import type * as React from 'react';

/** 一个 CSS 变量的浅色/深色值。 */
export interface ThemeTokenValue {
  light: string;
  dark: string;
}

/** DSH 客户端 theme 服务（@deepseek-ai/dsh-client-ui-theme）。 */
export interface ThemeService {
  /** 叠加一层主题 token 覆盖，返回一个卸载函数。 */
  overrideTokens(source: string, tokens: Record<string, ThemeTokenValue>): () => void;
}

/** slot 内某个插件的注册选项（shell.overlay / settings.section）。 */
export interface SlotRegisterOptions {
  name: string;
  id: string;
  order?: number;
  label?: string;
}

/** DSH 客户端 slots 服务（@deepseek-ai/dsh-client-runtime/client）。 */
export interface SlotsService {
  /** 向某个 slot 注入一个注册函数（返回卸载函数可选）。 */
  inject(name: string, setup: () => void | (() => void)): void | (() => void);
  /** 在当前 slot 内注册一个渲染组件，返回卸载函数可选。 */
  register(options: SlotRegisterOptions, render: () => React.ReactNode): void | (() => void);
}

/** 客户端插件依赖到的服务：key → 服务类型。 */
export interface ClientServices {
  theme: ThemeService;
  slots: SlotsService;
}

/** 客户端 Cordis 插件上下文的最小类型面（只列出插件用到的成员）。 */
export interface ClientCtx {
  /** 可选读取一个服务（可能为 undefined）。 */
  get<S extends keyof ClientServices>(service: S): ClientServices[S] | undefined;
  /** 注册一个副作用/清理函数。 */
  effect(fn: () => void | (() => void), label?: string): void;
}

/** 客户端插件导出的标准字段：`inject`（依赖的服务名）+ `apply`。 */
export interface ClientPlugin {
  inject: readonly string[];
  apply(ctx: ClientCtx): void;
}
