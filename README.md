> **Language / 语言：** **English** (current) · [简体中文](./README.zh-CN.md)

# xiao-ui-theme-ts

A **highly customizable theme plugin** for DeepSeek Harness (ships with a "Xiao" jade-green look by default). It themes the DeepSeek Harness web UI: colors, mascot badge, frosted background, and injected voice are all configurable. Out of the box it's a Xiao-style jade/emerald theme, but the accent color, badge text, voice, and background transparency are all tweakable — make it your own.

## What is this

Gives the DeepSeek Harness web UI a heavily customizable theme. **By default it's the jade-green "Xiao" look** (jade palette + mascot badge + Xiao-style voice + frosted background), but every part is adjustable: accent color, badge text, voice toggle/language/content, background image and transparency. It also optionally injects a "Xiao-style voice" into the session — turn it on if you want the assistant to speak like Xiao, off if not. It only changes tone/style, never the substance of the answer.

## Preview

<img width="2515" height="1288" alt="Screenshot 2026-08-23 181933" src="https://github.com/user-attachments/assets/3998f58b-53db-4349-80f3-3d993c6ad3c3" />

## Features

- **Customizable palette (jade/emerald by default)**: light / dark jade palettes; pick the accent with a color wheel, and toggle the theme off from settings.
- **Mascot badge**: a draggable, collapsible badge (bottom-right); title and subtitle can be set to any text.
- **Xiao-style voice**: injects a Xiao-voice instruction into the system prompt (toggleable), with Chinese / English templates or your own custom prompt.
- **Frosted background**: configurable background image (relative plugin path, local absolute path, or direct upload), with adjustable blur and UI transparency.
- **UI & sidebar transparency control**: UI opacity (0.3–0.9) controls the main content area; sidebar opacity (0–1) independently controls the left/right sidebars, up to 100% fully opaque while always letting part of the background through.
- **Accent color**: jade green by default, or pick any accent via the color wheel; the whole jade palette (panel surfaces, borders, brand color, sidebars, background gradient) shifts in sync, persisted after change.
- **Settings page**: master toggle, accent color, inject voice, template language, custom prompt, avatar path, mascot title/subtitle, frosted background (on/path/upload/blur/opacity), UI and sidebar opacity.

## Requirements

- DeepSeek Harness (`dsh` available)
- Node.js (≥ 18 recommended)
- [pnpm](https://pnpm.io/)

## Install online (quick)

1. Make sure the `dsh` command is available.
2. Run:
```bash
dsh plugin --profile web add https://github.com/jinxlux/xiao-theme-dsh-ui-plugin/releases/download/xiao-ui-theme-ts-0.6.0/xiao-ui-theme-ts-0.6.0.tgz
```

## Install from source (clone)

```bash
git clone <copied-repo-url>
cd xiao-ui-theme-ts

pnpm install       # install build dependencies
pnpm run build     # produce lib/ (ESM Host + ModuleLoader Client + declarations)
pnpm run check     # optional: verify the artifact satisfies the dsh plugin contract
```

Then attach it as a bundle to a DSH profile:

```bash
# relative path (run from a sibling directory)
dsh plugin --profile web add "./xiao-ui-theme-ts"
# or an absolute path
dsh plugin --profile web add "D:/.../xiao-ui-theme-ts"
```

> `dsh plugin add` installs the package into the profile and, thanks to its `dsh.bundle` declaration, **automatically hooks it into the bundle stack** — no manual config needed.
> Refresh / restart DSH Web for the theme to take effect.

## Usage & configuration

- Open DSH Web → **Settings → Xiao Theme**: master toggle, accent color, inject voice, template language, custom prompt, avatar path, mascot title/subtitle, frosted background (on / path / upload / blur / opacity), UI opacity, sidebar opacity.
- **Accent color**: pick an accent with the color wheel (default jade green `#2E8B72`); the panel surfaces, borders, brand color, sidebars and background gradient all shift in sync. Semantic state colors (error / warning / success) stay fixed and don't follow the accent.
- **Mascot text**: badge title (default "靖妖傩舞") and subtitle (default "别挡路") can be set to any text; an empty title falls back to the default.
- **UI opacity**: controls the main content area, range 0.3–0.9, capped so at least ~10% of the background stays visible.
- **Sidebar opacity**: independently controls the left/right sidebars, range 0–1, up to 100% fully opaque; the left is DSH's own sidebar, and the right also targets the third-party better-sidebar plugin (`data-dsh-panel` / `data-dsh-pane`) — ignored automatically if that plugin isn't installed.
- Changes take effect **immediately**, no DSH restart needed.
- Settings are saved to `~/.dsh/xiao-theme.json`; uploaded background images go to `~/.dsh/xiao-theme-uploads/` (user-level, not shipped with the repo).

## Notes

- **Build before mounting**: `lib/` is build output, not committed. After clone, run `pnpm install && pnpm run build` first, then `dsh plugin add`; adding an unbuilt directory fails because `lib/` is missing.
- Default avatar / background use **in-package relative paths** (`resource/avatar.png`, `resource/bg.svg`), readable across machines; keep `resource/` at the same level as `lib/` after building (current layout works).
- The Xiao-voice prompt depends on DSH's `systemPrompt` assembly. If the agent preset filters the prompt down to only a persona, or uses a **complete persona**, the voice may not appear in that session (that's preset behavior, not a plugin bug).
- "Sidebar opacity" targets DSH's `sidebarCol / detailsCol` columns and the third-party better-sidebar's `data-dsh-panel / data-dsh-pane` attributes; without better-sidebar installed, the right-side rules simply do nothing and don't affect the main UI.
- This plugin **does not read environment variables** for configuration; settings come only from `~/.dsh/xiao-theme.json` and compile-time defaults.

## License & disclaimers

- **Code**: this repository's source is open-source under the **MIT license** (see `LICENSE`); study, modify, and redistribute as permitted.
- **Images**: `resource/` (bg.svg, avatar.png, plus user-uploaded background images) come from **public online sources**, provided only for demo / customization of this theme.
- **Character & setting**: Xiao and the Genshin Impact character likeness, names, related settings, and art assets are **copyrighted by miHoYo**. The MIT license **covers only this repository's code** and does **not** cover miHoYo's character likeness / setting / original art. Content including related assets (`resource/` and theme showcases) **may not be used commercially or repurposed** without permission. To redistribute or use commercially, obtain a license from miHoYo first; removing or replacing the assets in `resource/` avoids this constraint. See the "Character Image & Setting Intellectual Property Notice" in `LICENSE`.
