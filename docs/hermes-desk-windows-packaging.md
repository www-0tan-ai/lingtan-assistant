# HermesDesk（Windows）打包说明

本文说明如何在 Windows x64 上从源码构建 **HermesDesk** 便携版：Electron 壳 + PyInstaller 打包的 Python 侧车（`tui_gateway` WebSocket + 静态 UI），以及首次运行时的数据目录行为。

## 环境与依赖

| 项目 | 说明 |
|------|------|
| 操作系统 | Windows 10/11 **x64** |
| Python | 3.11+（建议使用仓库根目录 `.venv`） |
| Node.js | 18+（用于 `electron/` 下 npm 与 electron-builder） |
| 网络 | 首次构建需下载 PyPI / npm 依赖及 Electron 二进制 |

可选：安装 **Ollama** 并执行 `ollama pull llama3.2`，与内置默认 `config.defaults.yaml` 一致，便于打包后无需 API Key 即可本地对话。

## 一键打包

在仓库根目录执行：

```powershell
.\scripts\build_windows_electron_desktop.ps1
```

脚本会依次：

1. `pip install -e ".[cli,electron-shell]"` 与 `pyinstaller`
2. 使用 `packaging/pyinstaller/hermes_electron_sidecar.spec` 生成 **Python 侧车**（onedir）
3. 进入 `electron/`，`npm install` 后执行 `npm run pack:win`（electron-builder **portable**）

## 构建产物路径

| 路径 | 含义 |
|------|------|
| `dist/hermes-electron-sidecar/` | PyInstaller 侧车目录（含 `hermes-electron-sidecar.exe` 与 `_internal`） |
| `dist-electron-pack/HermesDesk-<version>-portable.exe` | **单文件便携启动器**（内含 Electron、renderer、侧车资源） |

版本号取自 `electron/package.json` 的 `version` 字段（当前为 `0.1.0` 时，文件名为 `HermesDesk-0.1.0-portable.exe`）。

> **注意**：`dist/` 与 `dist-electron-pack/` 体积较大，**不要提交到 Git**。分发时请使用 GitHub Releases（或其它制品库）上传 `HermesDesk-*-portable.exe`。

## 首次运行与 `hermes_data`

打包后的便携 EXE 启动时，主进程会将 `HERMES_HOME` 设为：

`<便携 EXE 所在目录>\hermes_data`

若该目录下尚无 `config.yaml` / `.env`，侧车会从内置的 `packaging/bundled/hermes_desk/` 模板复制：

- `config.defaults.yaml` → `hermes_data/config.yaml`
- `env.sample` → `hermes_data/.env`

默认模型配置指向本机 **Ollama**（`http://127.0.0.1:11434/v1`，模型名 `llama3.2`）。改用云端时，请编辑 `hermes_data/config.yaml` 并在 `hermes_data/.env` 中填写对应密钥（勿将含真实密钥的文件提交仓库）。

## 相关文件索引

- 构建脚本：`scripts/build_windows_electron_desktop.ps1`
- Electron 配置：`electron/electron-builder.yml`、`electron/main.cjs`
- 侧车入口与便携逻辑：`packaging/pyinstaller/electron_sidecar_entry.py`
- PyInstaller 规格：`packaging/pyinstaller/hermes_electron_sidecar.spec`
- 内置默认配置模板：`packaging/bundled/hermes_desk/`

## 常见问题

**1. electron-builder 报错：Cannot create symbolic link / 客户端没有所需的特权**

- 原因：electron-builder 在尝试处理代码签名缓存（`winCodeSign`）时，解压出的归档里含 **符号链接**；在未开启 Windows「开发者模式」或未以可创建 symlink 的方式运行时，7-Zip 会失败。
- 处理：本仓库已在 `electron/electron-builder.yml` 中设置 `signAndEditExecutable: false`、`signDlls: false`，并在 `build_windows_electron_desktop.ps1` 中设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，以跳过不必要的签名链。
- 若仍失败：可开启 **设置 → 隐私和安全性 → 开发者模式**，或使用**以管理员身份运行**的终端重试（不推荐作为默认流程）。

**2. 构建失败：找不到侧车目录**

- 必须先成功执行 PyInstaller，使 `dist/hermes-electron-sidecar` 存在；electron-builder 通过 `extraResources` 将其复制到 `resources/sidecar`。

**3. 运行后无法连上模型**

- 若使用默认 Ollama：确认 Ollama 已启动且已 `ollama pull` 对应模型。
- 若使用云端：检查 `hermes_data/config.yaml` 与 `.env` 是否匹配服务商要求。

**4. 仅开发调试（不打包）**

- 在仓库根目录配置好 `.venv`，在 `electron/` 下 `npm install` 后 `npm start`；此时由 `main.cjs` 使用 `.venv` 中的 `python -m hermes_electron`，而非 frozen 侧车。

**5. `pip install -e` 报错 `WinError 32`（文件被占用）**

- 通常因本机正在运行 `hermes.exe`（或其它进程占用 `.venv\Scripts\hermes.exe`）。关闭相关进程后重试打包脚本。

## 分发建议

1. 在 CI 或本机构建得到 `HermesDesk-*-portable.exe`。
2. 计算校验和（如 SHA256）并写入 Release 说明。
3. 将 exe 作为 **Release 附件**上传；仓库源码仅保留文档与脚本，不跟踪大二进制文件。
