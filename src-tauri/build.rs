fn main() {
    println!("cargo:rerun-if-env-changed=LUMI_RELEASE_CHANNEL");
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
