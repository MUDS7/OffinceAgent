# OffinceAgent

Tauri + React + Rust + Python 文档处理服务的桌面 Agent 项目骨架。

## 结构

```text
.
├─ src/                         # React + Vite 前端
├─ src-tauri/                   # Tauri v2 + Rust 本地命令层
├─ services/document-service/   # Python FastAPI 文档处理服务
└─ scripts/                     # Windows PowerShell 启动脚本
```

## 初始化环境

```powershell
.\scripts\setup.ps1
```

如果当前机器的 Python 不能创建 venv，脚本会自动把依赖安装到
`services/document-service/.packages`，`run.py` 会在启动时加载这个目录。

等价手动命令：

```powershell
npm install
python -m venv services/document-service/.venv
services/document-service/.venv/Scripts/python.exe -m pip install -r services/document-service/requirements.txt
```

venv 不可用时：

```powershell
python -m pip install --upgrade --target services/document-service/.packages -r services/document-service/requirements.txt
```

## 开发启动

```powershell
.\scripts\dev.ps1
```

这会并行启动：

- Python 文档服务：http://127.0.0.1:8765
- Tauri 桌面应用，前端 dev server 端口：http://127.0.0.1:1420

## 编译和打包

首次编译前先初始化依赖：

```powershell
.\scripts\setup.ps1
```

检查前端 TypeScript：

```powershell
npm run typecheck
```

只编译前端静态资源：

```powershell
npm run build:frontend
```

编译并打包 Tauri 桌面应用：

```powershell
npm run build
```

`npm run build` 会先执行前端构建，再执行 `tauri build`。打包产物通常会输出到：

```text
src-tauri/target/release/bundle/
```

只检查 Rust/Tauri 代码是否能编译：

```powershell
cd src-tauri
cargo check
```

## 常用命令

```powershell
npm run typecheck
npm run build
cd src-tauri
cargo check
```

## Python 文档服务 API

- `GET /health`
- `POST /documents/analyze`，字段名为 `file`

当前内置 TXT、Markdown、CSV、JSON、PDF、DOCX 的基础文本预览和文件指纹计算。
