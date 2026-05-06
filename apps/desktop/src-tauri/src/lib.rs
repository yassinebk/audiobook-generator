use rusqlite::Connection;
use std::process::Command;
use std::sync::{mpsc, Mutex};

// ── Shared DB state ────────────────────────────────────────────────────────

struct Db(Mutex<Connection>);

fn get_db() -> &'static Db {
    static DB: std::sync::OnceLock<Db> = std::sync::OnceLock::new();
    DB.get_or_init(|| {
        let db_path = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("audiobook-generator")
            .join("audiobook.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).ok();
        let conn = Connection::open(&db_path).expect("failed to open database");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, source_path TEXT NOT NULL,
                source_language TEXT NOT NULL, output_language TEXT NOT NULL, work_dir TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chapters (
                id TEXT NOT NULL, book_id TEXT NOT NULL, title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', script_path TEXT,
                PRIMARY KEY (id, book_id)
            );",
        )
        .expect("failed to create tables");
        Db(Mutex::new(conn))
    })
}

// ── Book commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn db_create_book(id: String, title: String, source_path: String, work_dir: String) -> Result<(), String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO books (id, title, source_path, source_language, output_language, work_dir) VALUES (?1, ?2, ?3, 'en', 'en', ?4)",
        rusqlite::params![id, title, source_path, work_dir],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_upsert_chapter(id: String, book_id: String, title: String, status: String, script_path: Option<String>) -> Result<(), String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO chapters (id, book_id, title, status, script_path) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, book_id, title, status, script_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_chapters_with_scripts(book_id: String) -> Result<Vec<serde_json::Value>, String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, script_path FROM chapters WHERE book_id = ?1 AND script_path IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![book_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "scriptPath": row.get::<_, String>(1)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

// ── Worker command ──────────────────────────────────────────────────────────

#[tauri::command]
async fn run_worker(command: String, input_json: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let input_path = temp_dir.join(format!("audiobook-{}-input.json", command));
    let output_path = temp_dir.join(format!("audiobook-{}-output.json", command));

    std::fs::write(&input_path, &input_json).map_err(|e| e.to_string())?;

    let worker_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().parent().unwrap().parent().unwrap()
        .join("workers").join("python");

    let python = worker_dir.join(".venv").join("bin").join("python3");
    let input = input_path.to_str().unwrap().to_string();
    let output = output_path.to_str().unwrap().to_string();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = Command::new(&python)
            .args(["-m", "audiobook_worker.cli", &command, &input, &output])
            .current_dir(&worker_dir)
            .env("AUDIOBOOK_TTS_DEVICE", "mps")
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .output();
        let _ = tx.send(result);
    });

    let result = rx.recv().map_err(|_| "Worker thread panicked".to_string())?
        .map_err(|e| format!("Failed to spawn worker: {}", e))?;

    if let Ok(output) = std::fs::read_to_string(&output_path) {
        return Ok(output);
    }
    Err(format!("Worker exited {:?}: {}", result.status.code(), String::from_utf8_lossy(&result.stderr)))
}

#[tauri::command]
async fn copy_file(from: String, to: String) -> Result<String, String> {
    std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    Ok(to)
}

// ── App entry ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = get_db(); // init DB on startup
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_worker, copy_file,
            db_create_book, db_upsert_chapter, db_get_chapters_with_scripts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
