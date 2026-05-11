# OfficeAgent

OfficeAgent 是一个基于 Tauri v2、React、Rust 和 Python FastAPI 的桌面端 Office/文档处理助手。项目由三部分组成：

- `src/`：React + Vite 前端界面
- `src-tauri/`：Tauri v2 + Rust 桌面壳、本地文件能力和 DeepSeek 调用
- `services/document-service/`：Python FastAPI 文档服务，用于文档分析和 Excel 操作

## 环境要求

请先确认本机已安装：

- Windows PowerShell
- Node.js 与 npm
- Python 3
- Rust 工具链
- Tauri v2 所需的 Windows 构建环境和 WebView2 Runtime

如果需要使用 AI 对话、文本编辑或 Excel 智能操作能力，请在项目根目录创建或更新 `.env`：

```env
DEEPSEEK_API_KEY=你的 DeepSeek API Key
```

文档索引由 Rust/Tauri 侧负责：文档结构和全文索引会写入应用数据目录下的 SQLite 数据库，向量检索使用内嵌本地 Qdrant 兼容存储，默认写入应用数据目录下的 `qdrant/office-agent-qdrant.sqlite3`。开发模式下会写入项目根目录的 `.data/qdrant/`，可按需覆盖：

```env
OFFICE_AGENT_QDRANT_PATH=.data/qdrant
OFFICE_AGENT_QDRANT_COLLECTION=officeagent_documents
```

## 首次安装

在项目根目录执行：

```powershell
.\scripts\setup.ps1
```

该脚本会完成两件事：

1. 执行 `npm install` 安装前端和 Tauri CLI 依赖。
2. 为 `services/document-service` 创建 Python 虚拟环境并安装依赖。

如果当前 Python 无法创建虚拟环境，脚本会自动退回到 `services/document-service/.packages` 目录安装依赖，应用启动时会自动加载该目录。

也可以手动安装：

```powershell
npm install
python -m venv services/document-service/.venv
services/document-service/.venv/Scripts/python.exe -m pip install -r services/document-service/requirements.txt
```

如果虚拟环境不可用，改用本地依赖目录：

```powershell
python -m pip install --upgrade --target services/document-service/.packages -r services/document-service/requirements.txt
```

## 开发运行

推荐直接执行：

```powershell
npm run dev
```

或：

```powershell
.\scripts\dev.ps1
```

启动流程如下：

1. `scripts/dev.ps1` 会先调用 `scripts/restart-document-service.ps1`，检查并重启占用 `8765` 端口的 OfficeAgent 文档服务。
2. Tauri 启动时会运行 `npm run dev:frontend`，启动 Vite 前端服务。
3. Tauri 桌面窗口打开后，Rust 侧会确认 Python 文档服务是否运行；未运行时会自动启动。

默认地址：

- 前端开发服务：`http://127.0.0.1:1420`
- Python 文档服务：`http://127.0.0.1:8765`
- 文档服务健康检查：`http://127.0.0.1:8765/health`
- 内嵌 Qdrant 兼容向量库：`.data/qdrant/`

## 单独运行文档服务

调试 Python 文档服务时，可以单独启动：

```powershell
npm run dev:python
```

或：

```powershell
python services/document-service/run.py
```

如需开启 FastAPI reload：

```powershell
$env:OFFICE_AGENT_DOCUMENT_SERVICE_RELOAD="1"
python services/document-service/run.py
```

常用接口：

- `GET /health`：检查服务状态
- `POST /documents/analyze`：上传文档并提取预览信息，表单字段名为 `file`
- `GET /excel/commands`：获取当前支持的 Excel 命令
- `POST /excel/execute`：执行 Excel 操作命令

当前文档分析支持 TXT、Markdown、CSV、JSON、PDF、DOCX 的基础文本预览。Excel 命令主要面向 `.xlsx` 文件。

## 常用开发命令

```powershell
npm run typecheck
npm run build:frontend
cd src-tauri
cargo check
```

命令说明：

- `npm run typecheck`：检查前端 TypeScript 类型。
- `npm run build:frontend`：执行 `tsc` 并构建前端静态资源到 `dist/`。
- `cargo check`：检查 Rust/Tauri 代码是否可以编译。

## 构建桌面应用

构建前建议先确认依赖完整：

```powershell
.\scripts\setup.ps1
```

只构建 Tauri 可执行文件，不生成安装包：

```powershell
npm run build
```

等价命令：

```powershell
npm run build:desktop
```

构建安装包：

```powershell
npm run build:installer
```

构建产物通常位于：

```text
src-tauri/target/release/
src-tauri/target/release/bundle/
```

## 常见问题

### 端口 8765 被占用

开发启动脚本会尝试识别并重启 OfficeAgent 自己的文档服务。如果 `8765` 被其他程序占用，脚本会保留该进程并提示警告，需要手动关闭占用端口的程序后再启动。

### DeepSeek API Key 未配置

如果聊天或智能编辑功能提示 `DEEPSEEK_API_KEY is not set`，请在项目根目录的 `.env` 或 `.env.local` 中添加：

```env
DEEPSEEK_API_KEY=你的 DeepSeek API Key
```

### Python 命令不可用

Rust 侧启动文档服务时会依次尝试：

```text
OFFICE_AGENT_PYTHON
python
py -3
python3
```

如果你的 Python 不在默认路径中，可以在启动前指定：

```powershell
$env:OFFICE_AGENT_PYTHON="C:\Path\To\python.exe"
npm run dev
```

### PowerShell 脚本无法执行

如果本机执行策略拦截脚本，可以使用 npm 脚本启动：

```powershell
npm run dev
```

该命令已带有 `-ExecutionPolicy Bypass` 参数。
