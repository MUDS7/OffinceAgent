use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use tauri::Manager;

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

/// 初始化文档服务：若端口未被占用，则从资源目录或源码目录启动服务。
pub(crate) fn setup_document_service(app: &mut tauri::App) {
    let child = if is_document_service_running() {
        None
    } else {
        match resolve_document_service_dir(app).and_then(start_document_service) {
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
}

#[tauri::command]
/// Tauri 命令：查询文档服务是否正在运行。
pub(crate) fn get_document_service_status() -> ServiceStatus {
    ServiceStatus {
        running: is_document_service_running(),
        endpoint: DOCUMENT_SERVICE_ENDPOINT,
    }
}

/// 通过本地 TCP 连接快速判断文档服务端口是否已经可用。
fn is_document_service_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], DOCUMENT_SERVICE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok()
}

/// 解析文档服务目录。
///
/// 打包后优先使用 Tauri resource 中的 `document-service`，开发时回退到源码目录。
fn resolve_document_service_dir(app: &tauri::App) -> Result<PathBuf, String> {
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
