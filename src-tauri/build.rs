use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn command_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn command_bytes(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn is_git_build_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn resolve_build_id() -> String {
    for key in ["LUMI_BUILD_ID", "GIT_COMMIT"] {
        if let Ok(value) = std::env::var(key) {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                continue;
            }
            if !is_git_build_id(&normalized) {
                panic!("{key} must be a full 40- or 64-character hexadecimal Git object id");
            }
            return normalized;
        }
    }
    let git_head = command_output(&["rev-parse", "HEAD"])
        .unwrap_or_else(|| panic!("LUMI_BUILD_ID is unset and git rev-parse HEAD failed"))
        .to_ascii_lowercase();
    if !is_git_build_id(&git_head) {
        panic!("git rev-parse HEAD did not return a full Git object id");
    }
    git_head
}

fn update_hash_part(hash: &mut Sha256, label: &str, value: &[u8]) {
    hash.update(label.as_bytes());
    hash.update([0]);
    hash.update(value.len().to_string().as_bytes());
    hash.update([0]);
    hash.update(value);
    hash.update([0]);
}

fn source_identity(build_id: &str) -> (bool, String) {
    let root = command_output(&["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("Unable to resolve the Git worktree for source identity"));
    let source_head = command_output(&["rev-parse", "HEAD"])
        .unwrap_or_else(|| panic!("Unable to resolve the source snapshot HEAD"))
        .to_ascii_lowercase();
    if source_head != build_id {
        panic!(
            "LUMI_BUILD_ID/GIT_COMMIT ({build_id}) does not match the source snapshot HEAD ({source_head})"
        );
    }
    let status = command_bytes(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .unwrap_or_else(|| panic!("Unable to read Git status for source identity"));
    let diff = command_bytes(&root, &["diff", "--binary", "--no-ext-diff", "HEAD", "--"])
        .unwrap_or_else(|| panic!("Unable to read Git diff for source identity"));
    let mut untracked_paths = status
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"?? "))
        .map(|entry| {
            String::from_utf8(entry.to_vec())
                .unwrap_or_else(|_| panic!("Untracked source path is not valid UTF-8"))
        })
        .collect::<Vec<_>>();
    untracked_paths.sort();

    let mut hash = Sha256::new();
    update_hash_part(&mut hash, "head", source_head.as_bytes());
    update_hash_part(&mut hash, "status", &status);
    update_hash_part(&mut hash, "diff", &diff);
    for relative_path in untracked_paths {
        let normalized_path = relative_path.replace('\\', "/");
        let content = fs::read(root.join(&relative_path)).unwrap_or_else(|error| {
            panic!("Unable to read untracked source {relative_path}: {error}")
        });
        update_hash_part(&mut hash, "untracked-path", normalized_path.as_bytes());
        update_hash_part(&mut hash, "untracked-content", &content);
    }
    (!status.is_empty(), format!("{:x}", hash.finalize()))
}

fn emit_git_rerun_paths() {
    let Some(git_dir) = command_output(&["rev-parse", "--absolute-git-dir"]) else {
        return;
    };
    let git_dir = PathBuf::from(git_dir);
    println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    if let Some(reference) = command_output(&["symbolic-ref", "-q", "HEAD"]) {
        println!(
            "cargo:rerun-if-changed={}",
            git_dir
                .join(reference.replace('/', std::path::MAIN_SEPARATOR_STR))
                .display()
        );
    }
    println!(
        "cargo:rerun-if-changed={}",
        git_dir.join("packed-refs").display()
    );
    println!("cargo:rerun-if-changed={}", git_dir.join("index").display());
    for relative in [
        "../server",
        "../shared",
        "../src",
        "../scripts",
        "../test",
        "../.github",
        "../package.json",
        "../tsconfig.json",
        "../vite.config.ts",
        "src",
        "tauri.conf.json",
        "Cargo.toml",
    ] {
        println!("cargo:rerun-if-changed={relative}");
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=LUMI_BUILD_ID");
    println!("cargo:rerun-if-env-changed=GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=LUMI_RELEASE_CHANNEL");
    emit_git_rerun_paths();
    let build_id = resolve_build_id();
    let (source_dirty, source_fingerprint) = source_identity(&build_id);
    println!("cargo:rustc-env=LUMI_BUILD_ID={build_id}");
    println!("cargo:rustc-env=LUMI_SOURCE_DIRTY={source_dirty}");
    println!("cargo:rustc-env=LUMI_SOURCE_FINGERPRINT={source_fingerprint}");
    println!("cargo:rerun-if-changed=windows-test-manifest.rc");
    println!("cargo:rerun-if-changed=windows-test-manifest.xml");
    let release_channel =
        std::env::var("LUMI_RELEASE_CHANNEL").unwrap_or_else(|_| "internal".to_string());
    println!("cargo:rustc-env=LUMI_RELEASE_CHANNEL={release_channel}");
    // Windows unit-test binaries do not inherit the application manifest that
    // tauri-build embeds into the real executable. Without an explicit v6
    // common-controls activation context they load comctl32 5.82 and fail at
    // process startup when a transitive UI dependency imports TaskDialogIndirect.
    embed_resource::compile_for_everything("windows-test-manifest.rc", embed_resource::NONE)
        .manifest_required()
        .expect("failed to embed the Windows application/test manifest");
    // The shared resource above replaces tauri-build's bin-only default
    // manifest so application binaries and Rust test harnesses use the same
    // Common Controls activation context without duplicate resource IDs.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run the Tauri build helpers");
}
