// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn enable_readme_capture_webview_debugging() {
    // GitHub-hosted Windows runners can ignore inherited WebView2 browser
    // arguments. Set them inside the host process, before Tauri creates the
    // first WebView2 environment. This path is unreachable in normal launches.
    if std::env::var("NINETY_README_CAPTURE").as_deref() != Ok("1") {
        return;
    }

    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --remote-allow-origins=*",
    );
}

fn main() {
    enable_readme_capture_webview_debugging();
    ninety_lib::run()
}
