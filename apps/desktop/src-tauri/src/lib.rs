use std::process::Command;

#[tauri::command]
async fn run_worker(command: String, input_json: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let input_path = temp_dir.join(format!("audiobook-{}-input.json", command));
    let output_path = temp_dir.join(format!("audiobook-{}-output.json", command));

    std::fs::write(&input_path, &input_json).map_err(|e| e.to_string())?;

    let worker_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("workers/python");

    let python = worker_dir.join(".venv/bin/python3");

    let input = input_path.to_str().unwrap().to_string();
    let output = output_path.to_str().unwrap().to_string();

    let result = tokio::task::spawn_blocking(move || {
        Command::new(&python)
            .args([
                "-m",
                "audiobook_worker.cli",
                &command,
                &input,
                &output,
            ])
            .current_dir(&worker_dir)
            .output()
    })
    .await
    .map_err(|e| format!("Worker task join failed: {}", e))?
    .map_err(|e| format!("Failed to spawn worker: {}", e))?;

    if let Ok(output) = std::fs::read_to_string(&output_path) {
        return Ok(output);
    }

    Err(format!(
        "Worker exited {:?}: {}",
        result.status.code(),
        String::from_utf8_lossy(&result.stderr)
    ))
}

#[tauri::command]
fn copy_file(from: String, to: String) -> Result<String, String> {
    std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    Ok(to)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_worker, copy_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
