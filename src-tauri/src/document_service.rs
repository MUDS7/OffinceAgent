use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, State};

/// 本地 Python 文档服务的 HTTP 地址，供前端或状态接口展示。
const DOCUMENT_SERVICE_ENDPOINT: &str = "http://127.0.0.1:8765";
/// 文档服务监听端口，用于启动前探测服务是否已经存在。
const DOCUMENT_SERVICE_PORT: u16 = 8765;

/// 被 Tauri 托管的文档服务子进程。
///
/// 子进程放在 `Mutex<Option<_>>` 中，方便在应用关闭时安全取出并终止。
pub(crate) struct DocumentServiceProcess {
    child: Mutex<Option<Child>>,
}

impl Drop for DocumentServiceProcess {
    /// 应用状态释放时关闭由本进程启动的 Python 文档服务。
    fn drop(&mut self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };

        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 返回给前端的文档服务运行状态。
#[derive(serde::Serialize)]
pub(crate) struct ServiceStatus {
    /// 当前端口是否可以连通。
    running: bool,
    /// 文档服务固定访问地址。
    endpoint: &'static str,
}

#[tauri::command]
/// Tauri 代理命令：在 WebView 无法直接 fetch 本地 HTTP 服务时生成 DOCX。
pub(crate) async fn render_docx_document(
    app: AppHandle,
    state: State<'_, DocumentServiceProcess>,
    filename: String,
    blocks: serde_json::Value,
) -> Result<Vec<u8>, String> {
    let render_summary = summarize_docx_blocks(&blocks);
    if !is_document_service_healthy() {
        let status = restart_document_service_process(&app, &state, false);
        if !status.running {
            return Err(format!(
                "文档服务重启后仍未就绪（文件：{filename}；{render_summary}）"
            ));
        }
    }

    match request_docx_render(&filename, &blocks).await {
        Ok(bytes) => Ok(bytes),
        Err(first_error) if first_error.should_retry_with_restart => {
            let status = restart_document_service_process(&app, &state, true);
            if !status.running {
                return Err(format!(
                    "{first_error}；强制重启后文档服务仍未就绪（文件：{filename}；{render_summary}）"
                ));
            }

            request_docx_render(&filename, &blocks)
                .await
                .map_err(|retry_error| {
                    format!(
                        "{first_error}；强制重启后重试仍失败（文件：{filename}；{render_summary}）：{retry_error}"
                    )
                })
        }
        Err(error) => Err(error.to_string()),
    }
}

struct DocumentRenderError {
    message: String,
    should_retry_with_restart: bool,
}

impl std::fmt::Display for DocumentRenderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

async fn request_docx_render(
    filename: &str,
    blocks: &serde_json::Value,
) -> Result<Vec<u8>, DocumentRenderError> {
    let render_summary = summarize_docx_blocks(blocks);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| DocumentRenderError {
            message: format!(
                "无法创建文档服务 HTTP 客户端（文件：{filename}；{render_summary}）：{error}"
            ),
            should_retry_with_restart: false,
        })?;

    let response = client
        .post(format!("{DOCUMENT_SERVICE_ENDPOINT}/docx/render"))
        .json(&serde_json::json!({
            "filename": filename,
            "blocks": blocks,
        }))
        .send()
        .await
        .map_err(|error| DocumentRenderError {
            message: format!("无法连接本地文档服务（文件：{filename}；{render_summary}）：{error}"),
            should_retry_with_restart: true,
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(DocumentRenderError {
            message: format!(
                "DOCX 生成服务返回 {status}（文件：{filename}；{render_summary}）：{}",
                truncate_message(&body, 500)
            ),
            should_retry_with_restart: status.is_server_error(),
        });
    }

    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| DocumentRenderError {
            message: format!(
                "读取 DOCX 生成结果失败（文件：{filename}；{render_summary}）：{error}"
            ),
            should_retry_with_restart: true,
        })
}

/// 初始化文档服务：若端口未被占用，则从资源目录或源码目录启动服务。
pub(crate) fn setup_document_service(app: &mut tauri::App) {
    let child = if is_document_service_running() {
        None
    } else {
        match resolve_document_service_dir(&app.handle()).and_then(start_document_service) {
            Ok(child) => Some(child),
            Err(error) => {
                eprintln!("failed to start document service: {error}");
                None
            }
        }
    };

    app.manage(DocumentServiceProcess {
        child: Mutex::new(child),
    });

    let _ = wait_for_document_service(Duration::from_secs(8));
}

#[tauri::command]
/// Tauri 命令：查询文档服务是否正在运行。
pub(crate) fn get_document_service_status() -> ServiceStatus {
    ServiceStatus {
        running: is_document_service_healthy(),
        endpoint: DOCUMENT_SERVICE_ENDPOINT,
    }
}

#[tauri::command]
/// Tauri 命令：在文档服务不可用时尝试重启。
pub(crate) fn restart_document_service(
    app: AppHandle,
    state: State<DocumentServiceProcess>,
) -> ServiceStatus {
    restart_document_service_process(&app, &state, false)
}

fn restart_document_service_process(
    app: &AppHandle,
    state: &State<DocumentServiceProcess>,
    force: bool,
) -> ServiceStatus {
    if !force && is_document_service_healthy() {
        return get_document_service_status();
    }

    if let Ok(mut child_slot) = state.child.lock() {
        if let Some(mut child) = child_slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        if force {
            stop_document_service_listeners();
        }

        if force || !is_document_service_running() {
            match resolve_document_service_dir(app).and_then(start_document_service) {
                Ok(child) => *child_slot = Some(child),
                Err(error) => eprintln!("failed to restart document service: {error}"),
            }
        }
    }

    let _ = wait_for_document_service(Duration::from_secs(8));
    get_document_service_status()
}

/// 通过本地 TCP 连接快速判断文档服务端口是否已经可用。
fn is_document_service_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], DOCUMENT_SERVICE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok()
}

fn is_document_service_healthy() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], DOCUMENT_SERVICE_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));

    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.contains("200")
        && response.contains("\"service\":\"document-service\"")
}

fn wait_for_document_service(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_document_service_healthy() {
            return true;
        }
        thread::sleep(Duration::from_millis(150));
    }

    false
}

fn truncate_message(message: &str, max_chars: usize) -> String {
    let trimmed = message.trim();
    trimmed.chars().take(max_chars).collect()
}

fn summarize_docx_blocks(blocks: &serde_json::Value) -> String {
    let Some(blocks) = blocks.as_array() else {
        return "内容块格式不是数组".to_string();
    };

    let mut paragraphs = 0;
    let mut tables = 0;
    let mut images = 0;
    for block in blocks {
        match block.get("type").and_then(serde_json::Value::as_str) {
            Some("paragraph") => paragraphs += 1,
            Some("table") => tables += 1,
            Some("image") => images += 1,
            _ => {}
        }
    }

    format!(
        "内容块 {} 个，段落 {} 个，表格 {} 个，图片 {} 个",
        blocks.len(),
        paragraphs,
        tables,
        images
    )
}

#[cfg(windows)]
fn stop_document_service_listeners() {
    let output = Command::new("netstat").args(["-ano", "-p", "tcp"]).output();

    let Ok(output) = output else {
        return;
    };

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if !line.contains(&format!(":{DOCUMENT_SERVICE_PORT}")) || !line.contains("LISTENING") {
            continue;
        }

        let Some(pid_text) = line.split_whitespace().last() else {
            continue;
        };

        let _ = Command::new("taskkill")
            .args(["/PID", pid_text, "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
}

#[cfg(not(windows))]
fn stop_document_service_listeners() {}

/// 解析文档服务目录。
///
/// 打包后优先使用 Tauri resource 中的 `document-service`，开发时回退到源码目录。
fn resolve_document_service_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("document-service"))
        .map_err(|error| format!("cannot resolve resource directory: {error}"))?;

    if resource_dir.join("run.py").exists() {
        return Ok(resource_dir);
    }

    let source_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "cannot resolve project root".to_string())?
        .join("services")
        .join("document-service");

    if source_dir.join("run.py").exists() {
        return Ok(source_dir);
    }

    Err(format!(
        "document service entrypoint not found at {}",
        resource_dir.join("run.py").display()
    ))
}

/// 尝试使用可用的 Python 命令启动文档服务。
fn start_document_service(service_dir: PathBuf) -> Result<Child, String> {
    // 允许用户通过环境变量指定虚拟环境或自定义 Python 可执行文件。
    let configured_python = std::env::var("OFFICE_AGENT_PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty());

    let mut candidates: Vec<(&str, Vec<&str>)> = Vec::new();
    if let Some(python) = configured_python.as_deref() {
        candidates.push((python, vec!["run.py"]));
    }
    candidates.push(("python", vec!["run.py"]));
    candidates.push(("py", vec!["-3", "run.py"]));
    candidates.push(("python3", vec!["run.py"]));

    let mut errors = Vec::new();
    for (program, args) in candidates {
        match spawn_python(program, &args, &service_dir) {
            Ok(child) => return Ok(child),
            Err(error) => errors.push(format!("{program}: {error}")),
        }
    }

    Err(format!(
        "unable to start bundled document service from {} ({})",
        service_dir.display(),
        errors.join("; ")
    ))
}

/// 按给定命令启动 `run.py`，并隐藏标准输入输出，避免弹出多余窗口或阻塞管道。
fn spawn_python(program: &str, args: &[&str], service_dir: &Path) -> Result<Child, std::io::Error> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(service_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows GUI 应用中启动 Python 时不显示控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}
