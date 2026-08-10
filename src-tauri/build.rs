fn main() {
    println!("cargo:rerun-if-env-changed=LUMI_RELEASE_CHANNEL");
    let release_channel =
        std::env::var("LUMI_RELEASE_CHANNEL").unwrap_or_else(|_| "internal".to_string());
    println!("cargo:rustc-env=LUMI_RELEASE_CHANNEL={release_channel}");
    tauri_build::build()
}
