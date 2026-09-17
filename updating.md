# 维护记录（Developer / Agent maintenance notes）

> 本文是**开发者 / Agent 维护文档**：按轮次记录每次改动及其坑，供后续 agent 接手。
> **最新一轮在最上面**；历史改动看 `git log`；README 只写用户可见的说明。

---

## 本轮：主题管理列表自带滚动（版本 0.11.0，未 bump）

- 状态：实现完成，`pnpm run check` 通过，`pnpm test` 全绿（Host 11 / Client 8）
- 改动面：**纯 Client**（`src/client.ts`）。Host、数据模型、主题路由全部未动 → `pnpm run build` 后**刷新页面**即可，不用重启 DSH。

### 问题

`ThemeManager` 把每个主题渲染成一个 `xiao-settings-row` 直接平铺在 `.xiao-settings-section` 里，section 与行都不限高，
所以这一块高度 = O(主题数)（约 43px / 主题）。真正在滚动的是 DSH 设置模态框的内容区
（`.VOzbGW_options{flex:1;min-height:0;overflow-y:auto}`，面板固定 `height:min(800px,100vh-48px)`）。
主题一多，主题管理就把整页顶长，下面的设置要滚很久才看得到。

### 改法（方案 A：自带滚动容器 + 紧凑行）

- 主题行外套 `.xiao-theme-list`：`max-height:min(40vh,280px)` + `overflow-y:auto` + `overflow-x:hidden` + `overscroll-behavior:contain`。
  块高与主题数解耦：主题少时不出滚动条，多了就在框内滚动，不顶长设置页。
- 列表上方 `.xiao-theme-list-head`：`主题列表` + 数量（`.xiao-theme-list-title`）。
- 行改紧凑：`.xiao-theme-row`（hover / 当前态底色；当前态左侧 `inset` 品牌色条）+ `.xiao-theme-namewrap` / `.xiao-theme-name`（省略号）
  + `当前` / `内置` 小胶囊（`.xiao-theme-tag` / `.xiao-theme-tag-active`）+ 小号操作按钮（`.xiao-theme-act`）。
- 内置主题不再渲染那个禁用的「删除」按钮，改为「内置」胶囊，`title` 复用 `builtinNotDelete` 提示。
- 新增 STR：`themeListTitle` / `activeTag` / `builtinTag`。
- 删除只被旧主题行使用的 `.xiao-settings-name` 规则。
- **交互语义零变化**：顶部 `<select>` 继续负责切换；重命名（行内编辑）、导出、删除（两步确认）、导入、刷新、恢复默认都不变。

### 追加：行内「使用」切换按钮

- 列表每行的**非当前主题**多一个「使用」按钮（`.xiao-theme-act-primary`，始终品牌色），点击调用既有 `onActivate` → `POST /xiao-theme/themes-activate`。
- 当前主题行不渲染该按钮；**编辑名称时也不渲染**（避免 blur 触发 rename 与 activate 并发）。
- 顶部 `<select>` 保留：两处都能切换 —— 选择器适合大 N 时键入跳转，行内按钮适合就近操作。
- 新增 STR：`useTheme`（按钮文字）、`useThemeHint`（按钮 title）。
- 纯插件内部渲染 + 复用既有路由，不新增任何 DSH 依赖 → 与 DSH 版本无关。

### 兼容性（为什么与 DSH 版本无关）

- 主题数据 / 路由都是插件自己的（`~/.dsh/xiao-theme.json` + `/xiao-theme/themes*`），DSH 不参与。
- 滚动容器只用标准 CSS（`max-height` / `overflow-y`），不选 DSH 哈希类名；**不再依赖宿主 `.options` 是否滚动**，比改前更抗版本变化。
- 限高写成 `min(40vh,280px)`：宿主面板本身是 `min(800px,100vh-48px)`，vh 兜底 + px 上限，宿主是模态框 / 整页 / 侧栏都稳。
- `settings.section` 注册 + 语言重注册、`--dsw-alias-*` token 用法均未改。

### 验证

```
pnpm run check   # tsc --noEmit + scripts/check-dsh.mjs
pnpm test        # build + host/client 单测
```

- 本机插件以 `link:`（junction）装到 `~/.dsh/profiles/web`，`lib/client.js` 构建后刷新页面即生效。
- `ThemeManager` 仍无 DOM 单测（项目测试刻意零第三方依赖）；本次未新增依赖，测试面不变。

### 关键符号

| 位置 | 符号 |
| --- | --- |
| `src/client.ts` | `ThemeManager`、STR `themeListTitle` / `activeTag` / `builtinTag`、`.xiao-theme-list`、`.xiao-theme-list-head`、`.xiao-theme-list-title`、`.xiao-theme-row` / `-active`、`.xiao-theme-namewrap`、`.xiao-theme-name`、`.xiao-theme-tag` / `-active`、`.xiao-theme-act`、`.xiao-theme-rename` |

---

## 上一轮：多背景轮播（multi-background rotation）

- 时间：上一轮改动（版本仍为 `0.10.1`，未 bump）
- 状态：实现完成，`pnpm run check` 通过，`pnpm test` 全绿（Host 11 / Client 8）
- **唯一未在真机确认的点：负 z-index 图层与根框架 `backdrop-filter` 的配合** —— 见「坑 8」

---

### 1. 需求语义（最终确认版）

用户原话要点，实现时不要自行改语义：

1. **静态图**：多张时按可配置「间隔」到点即切。
2. **动画 GIF**：**与静态同样管理**（按间隔切）。不用管「放完」。
3. **视频**：切换时间 = `max(间隔, 视频时长)`
   - 间隔 ≤ 时长 → **必须播完才切**（`loop=false` + `ended`）
   - 间隔 > 时长 → **循环播到点再切**（`loop=true` + 定时器）
4. **切换有一道渐变**：固定时长（现为常量 `BG_FADE_MS = 700`，**不做成设置项**）。
5. **完全向后兼容**：只设 1 张时行为必须与旧版**逐字一致** —— 无定时器、无渐变、无新图层。只有设到 ≥2 张才轮播。
6. 渐变瞬间最多 2 个视频并存（用户已明确接受这个缓冲开销）。

---

### 2. 数据模型与兼容策略

新增字段（`src/config.ts`）：

- `BackgroundEntry { path: string; dynamic: boolean }`
- `XiaoConfig.backgroundList: BackgroundEntry[]`
- `XiaoConfig.backgroundInterval: number`（秒，Host 与 Client 范围都是 **2–600**，默认 **30**）

**核心不变量：`backgroundImagePath / backgroundDynamic` 恒等于 `backgroundList[0]`。**

- 读：`normalizeConfig` 先取列表；列表缺失 / 为空 / 全非法时，用旧字段合成一项（长度恒 ≥ 1）。
- 写：把第 0 项回写到旧字段，让旧版本、旧导出、`/xiao-bg` 的旧读法继续有效。
- **判据是「列表长度 ≤ 1」**（`effectiveBackgroundList()`），不是「字段是否存在」。老配置因此零迁移即可工作。

```
老配置（无 backgroundList） → normalizeConfig 合成 [ {path, dynamic} ] → 客户端 length===1
                                        → 走单张快路径 → 与升级前完全一致
```

---

### 3. Host 侧改动（`src/index.ts`）

- `normalizeBackgroundList(raw)`（**已导出，供单测**）：只保留 `{path: 非空字符串, dynamic: boolean}`，按 path 去重，非法项丢弃，绝不返回外部引用。
- `normalizeConfig`：合成 + 镜像（见上）。`backgroundInterval` 走 clamp。
- `nextConfigFromBody`：三分支合并 —— ① 请求带合法列表 → 以它为准（新客户端每次发全量，走这条）；② 否则只带了单张路径 → 只改列表首项（兼容旧客户端 / 旧交互）；③ 都没有 → 沿用。之后统一镜像。
- `restoreDefaults` 改为返回 `normalizeConfig({})`（而不是 `{...HOST_DEFAULT_CONFIG}`），保证响应里也带合成好的列表，形态与 GET 一致。
- `/xiao-bg` 路由：先按 `?p=` **精确匹配列表中的某一项**，匹配不到再退回 `?i=` 合法下标，都失败回落第 0 项。
- `uploadUsedBy` 改为扫描整列表（否则多背景下 picker 会把已用文件显示成"未使用"）。

---

### 4. Client 侧改动（`src/client.ts`）

分层：

- `applyBackgroundChrome(cfg)`：**公共视觉层**（模糊、主色渐变、面板/侧栏不透明度变量、根框架 inline 兜底）。单张与轮播都调它，因此滑杆 / 明暗切换即时生效。
- `syncBackgroundSingle(cfg)`：**向后兼容快路径**，就是改动前的原实现（body 背景图 + 单个 `<video>` + 强制重排）。只在列表 ≤ 1 项时执行。
- `syncBackgroundRotation(cfg, list)`：轮播模式。
- `syncBackground(cfg)`：总入口，按 `on && list.length >= 2` 分发；从轮播切回单张时先 `stopRotation()`。

轮播引擎：

- 模块级 `rotation` 状态：`signature`（只含 list + interval）、`visible`（0/1）、`layers`、`timer`、`token`（世代号）。
- 两层 `.xiao-bg-layer`（`position:fixed; inset:0; z-index:-1` + CSS `transition:opacity 700ms`）。
- `prepareLayer()`：把一项渲染进"不可见层"，就绪后回调（返回视频时长）。
- `showRotationEntry()`：就绪后做 opacity 交叉渐变，翻转 `visible`，渐变结束（+80ms）释放旧层。
- `scheduleRotation()`：用 `videoPlaythroughPlan(intervalMs, durationMs)` 决定 `loop` / 等 `ended` / 定时器。
- `videoPlaythroughPlan()`（**已导出，供单测**）：纯函数，直接编码 `max(间隔, 时长)` 规则。
- `startRotation()`：首次铺层直接上屏（防闪白）；已在轮播中则淡入新的第 0 项（不闪、不空窗）。

配置写入：

- `withBackgroundMirror(next, patch)` 接在 `saveConfig` 里：patch 带 `backgroundList` → 用首项回写单张字段；patch 只带单张字段（旧交互）→ 只更新列表首项，其余保留。

---

### 5. 设置页

- `BackgroundListEditor`：列表 ≥ 2 项时显示行（缩略图 + 序号 + 文件名 + 动态/静态标签 + 上移/下移/移除）；始终有一个「从已上传文件添加」入口。
- `UploadPicker` 新增 `mode: 'replace' | 'add'`：
  - `replace`（默认）：原行为，点选 + 「使用此文件」写回第 1 张。页面上的「选择/上传背景图」用它。
  - `add`：**点缩略图即加入轮播**（不写配置，走 `onAdd`），`existingPaths` 里的标「已添加」并置灰，窗口内上传也会自动加入，底部按钮变「完成」。
- 列表行缩略图经 `bgThumbUrl()`：上传目录内走 `/xiao-theme/uploads-file?name=`，其他走 `/xiao-bg?i=`。

---

### 6. 坑（重点，改之前先读）

1. **绝不要用"写配置"来驱动轮播。**
   每切一次就写 `xiao-theme.json` = 每 N 秒一次磁盘写 + 触发全部订阅者。正确做法：客户端只改 URL（`/xiao-bg?i=&p=&v=`），配置只在用户编辑时写。

2. **`syncBackground` 会在每次 store 变更时被调用。**
   滑杆 pointerup、`theme/change`、任何 `saveConfig` 都会触发。所以轮播状态必须放模块级，并用 `signature`（只含 list + interval）判断"要不要重建"。若在里面无条件重建，用户拖一次不透明度就会重置轮播并重新加载视频。

3. **`/xiao-bg` 的安全边界不能破。**
   它**只能**在"配置内的列表"里取路径（`p` 精确匹配 / `i` 合法下标）。任何"顺手支持一下自定义路径"的改动都会变成任意文件读取（LFI）。

4. **CSS `background-image` 不可过渡。**
   所以交叉渐变必须用两个元素改 `opacity`。不要试图在 `body` 的 background-image 上做渐变。
   **单张背景的 `body` 背景图 + 强制重排路径不要动** —— 它是兼容性保证。

5. **动画 GIF 没有"播放结束"事件。**
   GIF 一律按间隔切（`entry.dynamic === true && isVideoPath(entry.path)` 为 false → interval）。若将来真要做"GIF 放完再切"，需要解析 GIF 帧延迟求和，且浏览器对 delay 有下限截断，不精确。

6. **`video.duration` 可能是 `NaN` / `Infinity`。**
   一律经 `videoPlaythroughPlan()`；时长不可用时回退"循环 + 定时器"。

7. **`ended` 与安全网定时器会都想推进。**
   `scheduleRotation` 的 `advance` 用 `fired` 去重并在触发时清 `rotation.timer`。改这段时别把去重删了，否则一次跳两格。

8. **（未验证）负 z-index 图层 vs 根框架 `backdrop-filter`。**
   图层是 `body` 的子元素、`z-index:-1`，机制上与旧 `body` 背景图一致，理论上会被框架磨砂采样，但**没有在真机截图确认**。
   若发现磨砂面板后面不跟着渐变：先查 DSH 是否给根框架建了独立 backdrop root / stacking context；调整图层挂载点（如挂到 `#root` 下，或改用 `body::before/::after`）即可，**不影响轮播逻辑**。

9. **镜像不变量：所有写入都要经 `saveConfig`。**
   `backgroundImagePath/backgroundDynamic` 必须恒等于 `backgroundList[0]`。直接 `store.set(...)` 带不一致数据会打破它。
   已知安全例外：`activateTheme` 里的 `store.set(res.config)` 来自服务端，已 `normalizeConfig`。

10. **把列表缩回 1 项必须显式写 `backgroundList`。**
    「使用静态/动态背景默认」两个按钮已同时写 `backgroundList: [{...}]`。只改单张字段会保留列表其余项，轮播仍继续。

11. **单张快路径 = 向后兼容承诺。**
    `syncBackgroundSingle()` 只在 `effectiveBackgroundList(cfg).length <= 1` 时执行，且用 `cfg.backgroundImagePath`（镜像保证 = list[0]）。改它等于改兼容性承诺。新增的公共部分请放 `applyBackgroundChrome()`。

12. **生效方式不同。**
    Host 改动（`src/index.ts`）需**重启 DSH Web**；Client 改动（`src/client.ts`）**刷新页面**即可。本机插件以 `link:` 装到 `~/.dsh/profiles/web`，所以 `pnpm run build` 后 `lib/` 立刻是活的。

13. **缩略图 URL 的依赖。**
    上传目录内的文件走 `/xiao-theme/uploads-file`（不受 `backgroundEnabled` 影响）；其他走 `/xiao-bg?i=`，它在 `enabled=false` 或 `backgroundEnabled=false` 时 404。
    判断依据是路径里含 `xiao-theme-uploads`（见 `bgThumbUrl`）。若改了上传目录命名，这里要同步。

14. **默认值 / 范围四处必须一致。**
    `HOST_DEFAULT_CONFIG`、`CLIENT_DEFAULT_CONFIG`、`HOST_RANGES`、`CLIENT_RANGES` 是各自自包含复制的（构建产物不依赖相对模块）。`backgroundInterval` 默认 30、范围 2–600，改一处要全改。

15. **视频开声音被拦截时先静音播。**
    与单张路径的策略一致：`play()` 失败且非静音 → 置 `muted=true` 重播，保证背景不放空（代价是可能没声音）。

---

### 7. 调试提示

- 轮播被意外重启？打断点看 `rotation.signature` 是否变化（只有 list / interval 变化才应该重建）。
- 异步回调（canplay / ended / 定时器）失效？看 `rotation.token` 是否已递增（`stopRotation` / `startRotation` 会 +1）。
- 背景不显示？看控制台有没有 `/xiao-bg` 404（`enabled` / `backgroundEnabled` / 路径 / 下标）。
- 层不透明但看不到图？看 `.xiao-bg-layer` 的 `opacity` 与 `background-image`，以及 `html.xiao-bg-layers` 类是否在。

---

### 8. 验证

```
pnpm run check   # tsc --noEmit + scripts/check-dsh.mjs（dsh 契约）
pnpm test        # 先 build，再跑 test/host.test.mjs + test/client.test.mjs
```

现有锚点（可直接单测的纯函数）：

- Host：`normalizeBackgroundList()`、`normalizeConfig()`（含合成 / 镜像 / 钳制）
- Client：`videoPlaythroughPlan()`（max(间隔, 时长) 的四种情况）

**没有覆盖的部分**：轮播的 DOM 时序（进层 / canplay / ended / 渐变 / 释放）没有 jsdom 测试 —— 项目测试刻意零第三方依赖，别为此引入 jsdom。

---

### 9. 未做 / 后续可做

- 真机确认「坑 8」（磨砂面板能否采样到负 z-index 图层）。
- 渐变时长是常量；若用户要求可调，加 `backgroundFadeMs` 字段 + 钳制（建议 ≤ 间隔的 40%）。
- GIF「放完再切」需要帧延迟解析，当前按需求归静态档。
- 缩略图目前按需加载（`loading="lazy"`）；上传目录很大时可考虑分页。

---

### 10. 关键符号索引

| 位置 | 符号 |
| --- | --- |
| `src/config.ts` | `BackgroundEntry`、`XiaoConfig.backgroundList`、`XiaoConfig.backgroundInterval` |
| `src/index.ts` | `normalizeBackgroundList`、`normalizeConfig`、`nextConfigFromBody`、`/xiao-bg` handler、`uploadUsedBy` |
| `src/client.ts` | `effectiveBackgroundList`、`applyBackgroundChrome`、`syncBackgroundSingle`、`syncBackground`、`syncBackgroundRotation`、`startRotation`、`showRotationEntry`、`prepareLayer`、`scheduleRotation`、`videoPlaythroughPlan`、`stopRotation`、`clearLayer`、`ensureRotationLayers`、`withBackgroundMirror`、`bgThumbUrl`、`BackgroundListEditor`、`UploadPicker` |