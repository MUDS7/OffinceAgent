use std::env;

pub(super) fn read_deepseek_api_key() -> Result<String, String> {
    load_dotenv_files();

    env::var("DEEPSEEK_API_KEY")
        .map(|api_key| api_key.trim().to_string())
        .ok()
        .filter(|api_key| !api_key.is_empty())
        .ok_or_else(|| {
            "DEEPSEEK_API_KEY is not set. Add DEEPSEEK_API_KEY=your_key to a .env file.".to_string()
        })
}

fn load_dotenv_files() {
    let _ = dotenvy::dotenv();

    for base_dir in dotenv_base_dirs() {
        let env_path = base_dir.join(".env");
        let local_env_path = base_dir.join(".env.local");

        let _ = dotenvy::from_path(env_path);
        let _ = dotenvy::from_path(local_env_path);
    }
}

fn dotenv_base_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(current_dir) = env::current_dir() {
        dirs.push(current_dir.clone());
        if let Some(parent_dir) = current_dir.parent() {
            dirs.push(parent_dir.to_path_buf());
        }
    }

    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dirs.push(manifest_dir.clone());
    if let Some(parent_dir) = manifest_dir.parent() {
        dirs.push(parent_dir.to_path_buf());
    }

    dirs
}

pub(super) fn normalize_deepseek_model(model: Option<&str>) -> String {
    match model.unwrap_or("deepseek-v4-flash").trim() {
        "" => "deepseek-v4-flash",
        "deepseek-v3" => "deepseek-chat",
        "deepseek-v4" => "deepseek-v4-flash",
        model => model,
    }
    .to_string()
}

pub(super) fn truncate_error_body(body: &str) -> String {
    const MAX_ERROR_CHARS: usize = 400;

    let truncated = body.chars().take(MAX_ERROR_CHARS).collect::<String>();
    if body.chars().count() > MAX_ERROR_CHARS {
        format!("{truncated}...")
    } else {
        truncated
    }
}
