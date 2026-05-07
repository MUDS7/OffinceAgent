use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use tauri::Manager;

const DOCUMENT_SERVICE_ENDPOINT: &str = "http://127.0.0.1:8765";
const DOCUMENT_SERVICE_PORT: u16 = 8765;

pub(crate) struct DocumentServiceProcess {
    child: Mutex<Option<Child>>,
}

impl Drop for DocumentServiceProcess {
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

#[derive(serde::Serialize)]
pub(crate) struct ServiceStatus {
    running: bool,
    endpoint: &'static str,
}

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
pub(crate) fn get_document_service_status() -> ServiceStatus {
    ServiceStatus {
        running: is_document_service_running(),
        endpoint: DOCUMENT_SERVICE_ENDPOINT,
    }
}

fn is_document_service_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], DOCUMENT_SERVICE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok()
}

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

fn start_document_service(service_dir: PathBuf) -> Result<Child, String> {
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
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}
