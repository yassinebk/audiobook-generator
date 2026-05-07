use chrono::Utc;
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
                source_language TEXT NOT NULL, output_language TEXT NOT NULL, work_dir TEXT NOT NULL,
                imported_at TEXT, updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS chapters (
                id TEXT NOT NULL, book_id TEXT NOT NULL, title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', script_path TEXT,
                PRIMARY KEY (id, book_id)
            );
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT NOT NULL, book_id TEXT NOT NULL, canonical_name TEXT NOT NULL,
                gender TEXT, voice_id TEXT, confidence REAL DEFAULT 0.0,
                aliases TEXT DEFAULT '[]', updated_at TEXT,
                PRIMARY KEY (id, book_id)
            );
            CREATE INDEX IF NOT EXISTS idx_books_source_path ON books(source_path);
            CREATE INDEX IF NOT EXISTS idx_characters_book_id ON characters(book_id);
            CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);",
        )
        .expect("failed to create tables");
        // Add columns to existing databases that lack them
        let has_imported_at = conn
            .prepare("SELECT imported_at FROM books LIMIT 1")
            .is_ok();
        if !has_imported_at {
            conn.execute("ALTER TABLE books ADD COLUMN imported_at TEXT", [])
                .expect("failed to add imported_at column");
            conn.execute("ALTER TABLE books ADD COLUMN updated_at TEXT", [])
                .expect("failed to add updated_at column");
        }
        Db(Mutex::new(conn))
    })
}

// ── Book commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn db_create_book(id: String, title: String, source_path: String, work_dir: String) -> Result<(), String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    db.execute(
        "INSERT OR REPLACE INTO books (id, title, source_path, source_language, output_language, work_dir, imported_at, updated_at) VALUES (?1, ?2, ?3, 'en', 'en', ?4, ?5, ?5)",
        rusqlite::params![id, title, source_path, work_dir, now],
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

#[tauri::command]
fn db_list_books() -> Result<Vec<serde_json::Value>, String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, title, source_path, work_dir, imported_at FROM books ORDER BY imported_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "sourcePath": row.get::<_, String>(2)?,
                "workDir": row.get::<_, String>(3)?,
                "importedAt": row.get::<_, Option<String>>(4)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn db_get_book(source_path: String) -> Result<Option<serde_json::Value>, String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, title, source_path, work_dir, imported_at FROM books WHERE source_path = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(rusqlite::params![source_path], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "sourcePath": row.get::<_, String>(2)?,
                "workDir": row.get::<_, String>(3)?,
                "importedAt": row.get::<_, Option<String>>(4)?
            }))
        })
        .map_err(|e| e.to_string())?;
    if let Some(row) = rows.next() {
        Ok(Some(row.map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn db_upsert_character(
    id: String, book_id: String, canonical_name: String,
    gender: Option<String>, voice_id: Option<String>,
    confidence: Option<f64>, aliases: Option<String>,
) -> Result<(), String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    db.execute(
        "INSERT OR REPLACE INTO characters (id, book_id, canonical_name, gender, voice_id, confidence, aliases, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, book_id, canonical_name, gender, voice_id, confidence, aliases, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_characters(book_id: String) -> Result<Vec<serde_json::Value>, String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, canonical_name, gender, voice_id, confidence, aliases FROM characters WHERE book_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![book_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "canonicalName": row.get::<_, String>(1)?,
                "gender": row.get::<_, Option<String>>(2)?,
                "voiceId": row.get::<_, Option<String>>(3)?,
                "confidence": row.get::<_, Option<f64>>(4)?,
                "aliases": row.get::<_, Option<String>>(5)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn db_get_chapters(book_id: String) -> Result<Vec<serde_json::Value>, String> {
    let db = get_db().0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, title, status, script_path FROM chapters WHERE book_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![book_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "scriptPath": row.get::<_, Option<String>>(3)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn book_work_dir(book_id: String) -> String {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("audiobook-generator")
        .join("books")
        .join(&book_id)
        .to_str()
        .unwrap()
        .to_string()
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
            book_work_dir,
            db_list_books, db_get_book, db_upsert_character, db_get_characters, db_get_chapters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
