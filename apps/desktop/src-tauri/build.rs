//! Embeds every `migrations/NNNN_name.sql` file under `apps/desktop/src` into
//! the binary, ordered by number (plan §5.3). Vitest runs the same files.

use std::fs;
use std::path::{Path, PathBuf};

fn collect(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "sql")
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "migrations")
        {
            found.push(path);
        }
    }
}

fn main() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
    println!("cargo:rerun-if-changed={}", src.display());

    let mut files = Vec::new();
    collect(&src, &mut files);
    files.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));

    let mut code = String::from("pub static MIGRATIONS: &[(&str, &str)] = &[\n");
    for path in &files {
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("migration file names are UTF-8");
        let absolute = path.canonicalize().expect("migration path resolves");
        println!("cargo:rerun-if-changed={}", absolute.display());
        code.push_str(&format!(
            "    ({name:?}, include_str!({:?})),\n",
            absolute.display().to_string()
        ));
    }
    code.push_str("];\n");

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    fs::write(out.join("migrations.rs"), code).expect("write migrations.rs");

    tauri_build::build()
}
