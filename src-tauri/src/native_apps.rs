#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::collections::HashSet;

use std::path::{Path, PathBuf};
use std::process::Command;

use std::sync::Mutex;
use std::time::{Instant, SystemTime};
#[cfg(not(test))]
use tauri_plugin_dialog::DialogExt;

#[cfg(not(target_os = "windows"))]
use crate::native_shell::decode_command_bytes;
use crate::spawn_hidden;
#[cfg(target_os = "windows")]
use crate::AppLaunchHistoryEntry;
use crate::CommandResult;
use crate::NativeAppEntry;

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsAppDefinition {
    app_id: &'static str,
    label: &'static str,
    aliases: Vec<&'static str>,
    executable_names: Vec<&'static str>,
    fixed_paths: Vec<&'static str>,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsLaunchCandidate {
    app_id: String,
    label: String,
    path: PathBuf,
    args: Vec<String>,
    source: String,
    aliases: Vec<String>,
    score: i32,
}

#[cfg(target_os = "windows")]
fn windows_app_definitions() -> Vec<WindowsAppDefinition> {
    vec![
        WindowsAppDefinition {
            app_id: "wechat",
            label: "WeChat",
            aliases: vec![
                "wechat",
                "weixin",
                "wechat.exe",
                "weixin.exe",
                "\u{5fae}\u{4fe1}",
                "\u{7535}\u{8111}\u{5fae}\u{4fe1}",
                "\u{4e2a}\u{4eba}\u{5fae}\u{4fe1}",
                "\u{5fae}\u{4fe1}\u{5ba2}\u{6237}\u{7aef}",
                "\u{5fae}\u{4fe1}\u{591a}\u{5f00}",
            ],
            executable_names: vec![
                "Weixin.exe",
                "WeChat.exe",
                "\u{5fae}\u{4fe1}\u{591a}\u{5f00}.bat",
                "\u{5fae}\u{4fe1}.lnk",
            ],
            fixed_paths: vec![
                r"D:\Weixin\Weixin.exe",
                r"%ProgramFiles%\Tencent\Weixin\Weixin.exe",
                r"%ProgramFiles%\Tencent\WeChat\Weixin.exe",
                r"%ProgramFiles%\Tencent\WeChat\WeChat.exe",
                r"%ProgramFiles(x86)%\Tencent\Weixin\Weixin.exe",
                r"%ProgramFiles(x86)%\Tencent\WeChat\Weixin.exe",
                r"%ProgramFiles(x86)%\Tencent\WeChat\WeChat.exe",
                r"%LOCALAPPDATA%\Tencent\WeChat\Weixin.exe",
                r"%LOCALAPPDATA%\Tencent\WeChat\WeChat.exe",
                r"%USERPROFILE%\Desktop\微信多开.bat",
                r"%USERPROFILE%\Desktop\微信.lnk",
            ],
        },
        WindowsAppDefinition {
            app_id: "wecom",
            label: "WeCom",
            aliases: vec![
                "wecom",
                "wxwork",
                "wxwork.exe",
                "\u{4f01}\u{4e1a}\u{5fae}\u{4fe1}",
                "\u{4f01}\u{5fae}",
            ],
            executable_names: vec![
                "WXWork.exe",
                "WeCom.exe",
                "\u{4f01}\u{4e1a}\u{5fae}\u{4fe1}.lnk",
            ],
            fixed_paths: vec![
                r"%ProgramFiles%\Tencent\WXWork\WXWork.exe",
                r"%ProgramFiles(x86)%\Tencent\WXWork\WXWork.exe",
                r"%LOCALAPPDATA%\Tencent\WXWork\WXWork.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "wps",
            label: "WPS Office",
            aliases: vec![
                "wps",
                "wps office",
                "wps writer",
                "wps spreadsheets",
                "\u{91d1}\u{5c71}\u{529e}\u{516c}",
                "\u{6587}\u{5b57}",
                "\u{8868}\u{683c}",
                "\u{6f14}\u{793a}",
                "word",
                "excel",
                "ppt",
            ],
            executable_names: vec![
                "wps.exe",
                "et.exe",
                "wpp.exe",
                "ksolaunch.exe",
                "WPS Office.lnk",
            ],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Kingsoft\WPS Office\ksolaunch.exe",
                r"%ProgramFiles%\Kingsoft\WPS Office\ksolaunch.exe",
                r"%ProgramFiles(x86)%\Kingsoft\WPS Office\ksolaunch.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "browser",
            label: "Browser",
            aliases: vec![
                "browser",
                "web browser",
                "\u{6d4f}\u{89c8}\u{5668}",
                "edge",
                "microsoft edge",
                "chrome",
                "\u{8c37}\u{6b4c}\u{6d4f}\u{89c8}\u{5668}",
            ],
            executable_names: vec![
                "msedge.exe",
                "chrome.exe",
                "Microsoft Edge.lnk",
                "Google Chrome.lnk",
            ],
            fixed_paths: vec![
                r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
                r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
                r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
                r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
                r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "vscode",
            label: "Visual Studio Code",
            aliases: vec!["vscode", "vs code", "visual studio code", "code"],
            executable_names: vec!["Code.exe", "Visual Studio Code.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
                r"%ProgramFiles%\Microsoft VS Code\Code.exe",
                r"%ProgramFiles(x86)%\Microsoft VS Code\Code.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "workbuddy",
            label: "WorkBuddy",
            aliases: vec!["workbuddy", "work buddy"],
            executable_names: vec!["WorkBuddy.exe", "WorkBuddy.lnk"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "codex",
            label: "Codex",
            aliases: vec!["codex", "openai codex"],
            executable_names: vec!["Codex.exe", "Codex.lnk"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "chatgpt",
            label: "ChatGPT",
            aliases: vec!["chatgpt", "openai chatgpt"],
            executable_names: vec!["ChatGPT.exe", "ChatGPT.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\ChatGPT\ChatGPT.exe",
                r"%ProgramFiles%\ChatGPT\ChatGPT.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "claude",
            label: "Claude",
            aliases: vec!["claude", "anthropic claude"],
            executable_names: vec!["Claude.exe", "Claude.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\AnthropicClaude\Claude.exe",
                r"%LOCALAPPDATA%\Programs\Claude\Claude.exe",
                r"%ProgramFiles%\Claude\Claude.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "cursor",
            label: "Cursor",
            aliases: vec!["cursor", "cursor ai", "cursor editor"],
            executable_names: vec!["Cursor.exe", "Cursor.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe",
                r"%ProgramFiles%\Cursor\Cursor.exe",
                r"D:\cursor\Cursor.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "lmstudio",
            label: "LM Studio",
            aliases: vec!["lmstudio", "lm studio"],
            executable_names: vec!["LM Studio.exe", "LM Studio.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe",
                r"%ProgramFiles%\LM Studio\LM Studio.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "cherry-studio",
            label: "Cherry Studio",
            aliases: vec!["cherry studio", "cherrystudio", "cherry ai"],
            executable_names: vec!["Cherry Studio.exe", "CherryStudio.exe", "Cherry Studio.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\CherryStudio\CherryStudio.exe",
                r"%ProgramFiles%\Cherry Studio\Cherry Studio.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "anythingllm",
            label: "AnythingLLM",
            aliases: vec!["anythingllm", "anything llm"],
            executable_names: vec!["AnythingLLM.exe", "AnythingLLM.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\AnythingLLM\AnythingLLM.exe",
                r"%ProgramFiles%\AnythingLLM\AnythingLLM.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "jianying",
            label: "Jianying",
            aliases: vec![
                "jianying",
                "capcut",
                "\u{526a}\u{6620}",
                "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}",
            ],
            executable_names: vec![
                "JianyingPro.exe",
                "CapCut.exe",
                "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}.lnk",
                "\u{526a}\u{6620}.lnk",
            ],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\JianyingPro\Apps\JianyingPro.exe",
                r"%ProgramFiles%\JianyingPro\JianyingPro.exe",
                r"%ProgramFiles(x86)%\JianyingPro\JianyingPro.exe",
                r"D:\JianyingPro\JianyingPro.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "autocad",
            label: "AutoCAD",
            aliases: vec![
                "autocad",
                "cad",
                "\u{5929}\u{6b63}",
                "\u{4e2d}\u{671b}cad",
                "\u{6d69}\u{8fb0}cad",
            ],
            executable_names: vec!["acad.exe", "AutoCAD.exe", "ZWCAD.exe", "GstarCAD.exe"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "feishu",
            label: "Feishu",
            aliases: vec!["feishu", "lark", "\u{98de}\u{4e66}"],
            executable_names: vec!["Feishu.exe", "Lark.exe", "\u{98de}\u{4e66}.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Feishu\Feishu.exe",
                r"%ProgramFiles%\Feishu\Feishu.exe",
                r"%ProgramFiles(x86)%\Feishu\Feishu.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "dingtalk",
            label: "DingTalk",
            aliases: vec!["dingtalk", "\u{9489}\u{9489}"],
            executable_names: vec!["DingTalk.exe", "\u{9489}\u{9489}.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\DingTalk\DingTalk.exe",
                r"%ProgramFiles%\DingDing\DingtalkLauncher.exe",
                r"%ProgramFiles(x86)%\DingDing\DingtalkLauncher.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "notepad",
            label: "Notepad",
            aliases: vec!["notepad", "notepad.exe", "\u{8bb0}\u{4e8b}\u{672c}"],
            executable_names: vec!["notepad.exe"],
            fixed_paths: vec![r"%WINDIR%\System32\notepad.exe"],
        },
        WindowsAppDefinition {
            app_id: "calculator",
            label: "Calculator",
            aliases: vec!["calculator", "calc", "calc.exe", "\u{8ba1}\u{7b97}\u{5668}"],
            executable_names: vec!["calc.exe", "CalculatorApp.exe"],
            fixed_paths: vec![r"%WINDIR%\System32\calc.exe"],
        },
        WindowsAppDefinition {
            app_id: "explorer",
            label: "File Explorer",
            aliases: vec![
                "explorer",
                "file explorer",
                "\u{6587}\u{4ef6}\u{8d44}\u{6e90}\u{7ba1}\u{7406}\u{5668}",
                "\u{8d44}\u{6e90}\u{7ba1}\u{7406}\u{5668}",
            ],
            executable_names: vec!["explorer.exe"],
            fixed_paths: vec![r"%WINDIR%\explorer.exe"],
        },
        WindowsAppDefinition {
            app_id: "powershell",
            label: "PowerShell",
            aliases: vec![
                "powershell",
                "pwsh",
                "\u{7ec8}\u{7aef}",
                "\u{547d}\u{4ee4}\u{884c}",
            ],
            executable_names: vec!["powershell.exe", "pwsh.exe", "Windows Terminal.lnk"],
            fixed_paths: vec![
                r"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe",
                r"%ProgramFiles%\PowerShell\7\pwsh.exe",
                r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe",
            ],
        },
    ]
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn compact_app_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn normalize_app_query(value: &str) -> String {
    let mut compact = compact_app_text(value);
    let prefixes = [
        "\u{5e2e}\u{6211}\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{5e2e}\u{6211}\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{8bf7}\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{8bf7}\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{5e2e}\u{6211}\u{6253}\u{5f00}",
        "\u{5e2e}\u{6211}\u{542f}\u{52a8}",
        "\u{8bf7}\u{6253}\u{5f00}",
        "\u{8bf7}\u{542f}\u{52a8}",
        "\u{6253}\u{5f00}",
        "\u{542f}\u{52a8}",
        "\u{8fd0}\u{884c}",
        "\u{8fdb}\u{5165}",
        "\u{6253}\u{5f00}",
        "pleaseopen",
        "launch",
        "start",
        "open",
        "run",
    ];
    for prefix in prefixes {
        let normalized_prefix = compact_app_text(prefix);
        if compact.starts_with(&normalized_prefix) {
            compact = compact[normalized_prefix.len()..].to_string();
            break;
        }
    }

    let location_prefixes = [
        "\u{684c}\u{9762}\u{4e0a}\u{7684}",
        "\u{684c}\u{9762}\u{91cc}\u{7684}",
        "\u{684c}\u{9762}\u{7684}",
        "\u{684c}\u{9762}\u{4e0a}",
        "\u{684c}\u{9762}\u{91cc}",
        "\u{684c}\u{9762}",
        "onthedesktop",
        "desktop",
    ];
    for prefix in location_prefixes {
        let normalized_prefix = compact_app_text(prefix);
        if compact.starts_with(&normalized_prefix) && compact.len() > normalized_prefix.len() {
            compact = compact[normalized_prefix.len()..].to_string();
            break;
        }
    }

    let suffixes = [
        "\u{5ba2}\u{6237}\u{7aef}",
        "\u{5e94}\u{7528}",
        "\u{8f6f}\u{4ef6}",
        "\u{7a0b}\u{5e8f}",
        "application",
        "client",
        "app",
    ];
    for suffix in suffixes {
        let normalized_suffix = compact_app_text(suffix);
        if compact.ends_with(&normalized_suffix) && compact.len() > normalized_suffix.len() {
            compact = compact[..compact.len() - normalized_suffix.len()].to_string();
            break;
        }
    }
    compact
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn unicode_edit_distance(left: &str, right: &str) -> usize {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left_chars.iter().enumerate() {
        let mut current = vec![left_index + 1; right_chars.len() + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current[right_index + 1] = std::cmp::min(
                std::cmp::min(current[right_index] + 1, previous[right_index + 1] + 1),
                previous[right_index] + usize::from(left_char != right_char),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn desktop_item_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs_next::home_dir() {
        roots.push(home.join("Desktop"));
    }
    #[cfg(target_os = "windows")]
    if let Ok(public_dir) = std::env::var("PUBLIC") {
        roots.push(PathBuf::from(public_dir).join("Desktop"));
    }
    roots
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn resolve_desktop_item_fuzzy(target: &str) -> Option<PathBuf> {
    let mut query = normalize_app_query(target);
    for suffix in [
        "\u{6587}\u{4ef6}\u{5939}",
        "\u{76ee}\u{5f55}",
        "folder",
        "directory",
    ] {
        let suffix = compact_app_text(suffix);
        if query.ends_with(&suffix) && query.len() > suffix.len() {
            query.truncate(query.len() - suffix.len());
            break;
        }
    }
    if query.is_empty() {
        return None;
    }

    let mut ranked: Vec<(usize, PathBuf)> = Vec::new();
    for root in desktop_item_roots() {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let label = path
                .file_stem()
                .or_else(|| path.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let candidate = compact_app_text(&label);
            if candidate.is_empty() {
                continue;
            }
            let distance = if candidate.contains(&query) || query.contains(&candidate) {
                0
            } else {
                unicode_edit_distance(&query, &candidate)
            };
            let threshold = std::cmp::max(1, query.chars().count() / 3);
            if distance <= threshold {
                ranked.push((distance, path));
            }
        }
    }
    ranked.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let best = ranked.first()?;
    if ranked.get(1).map(|next| next.0 == best.0).unwrap_or(false) {
        return None;
    }
    Some(best.1.clone())
}

#[cfg(all(test, target_os = "windows"))]
mod app_query_tests {
    use super::{
        normalize_app_query, resolve_app_definition, search_app_definitions,
        windows_app_definitions, WindowsAppDefinition,
    };

    #[test]
    fn strips_desktop_location_words_without_shortening_the_app_name() {
        assert_eq!(normalize_app_query("打开桌面上的网易云音乐"), "网易云音乐");
        assert_eq!(normalize_app_query("桌面的网易云音乐软件"), "网易云音乐");
        assert_eq!(normalize_app_query("打开微信消息值守"), "微信消息值守");
    }

    #[test]
    fn bilingual_search_finds_the_same_known_application_once() {
        let definitions = windows_app_definitions();
        for query in [
            "计算器 Calculator",
            "计算器 / Calculator",
            "Calculator（计算器）",
        ] {
            let matches = search_app_definitions(query, &definitions);
            assert_eq!(matches.len(), 1, "query: {query}");
            assert_eq!(matches[0].app_id, "calculator");
        }
        // Broader discovery must not silently broaden direct launch matching.
        assert!(resolve_app_definition("计算器 Calculator").is_none());
    }

    #[test]
    fn complete_application_names_with_spaces_take_precedence_over_fragments() {
        let definitions = vec![
            WindowsAppDefinition {
                app_id: "visual_studio_code",
                label: "Visual Studio Code",
                aliases: vec!["VS Code"],
                executable_names: vec!["Code.exe"],
                fixed_paths: vec![],
            },
            WindowsAppDefinition {
                app_id: "studio",
                label: "Studio",
                aliases: vec!["Studio"],
                executable_names: vec![],
                fixed_paths: vec![],
            },
        ];
        let matches = search_app_definitions("Visual Studio Code", &definitions);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].app_id, "visual_studio_code");
        let alias_matches = search_app_definitions("VS Code", &definitions);
        assert_eq!(alias_matches.len(), 1);
        assert_eq!(alias_matches[0].app_id, "visual_studio_code");
    }

    #[test]
    fn ambiguous_search_returns_all_candidates_without_picking_a_launch_target() {
        let definitions = windows_app_definitions();
        let matches = search_app_definitions("计算器 Notepad", &definitions);
        let ids: Vec<_> = matches.iter().map(|item| item.app_id).collect();
        assert!(ids.contains(&"calculator"));
        assert!(ids.contains(&"notepad"));
        assert_eq!(ids.len(), 2);
        assert!(resolve_app_definition("计算器 Notepad").is_none());
    }

    #[test]
    fn empty_or_unrelated_search_terms_do_not_match_every_application() {
        let definitions = windows_app_definitions();
        for query in ["", "  ", " / | （） ", "c", "CalculatorHelper"] {
            assert!(
                search_app_definitions(query, &definitions).is_empty(),
                "query: {query}"
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_app_roots() -> Vec<(PathBuf, &'static str, i32)> {
    let mut roots = vec![
        (PathBuf::from("/Applications"), "applications", 120),
        (
            PathBuf::from("/System/Applications"),
            "system_applications",
            90,
        ),
    ];
    if let Some(home) = dirs_next::home_dir() {
        roots.push((home.join("Applications"), "user_applications", 140));
    }
    roots
}

#[cfg(target_os = "macos")]
fn macos_app_aliases(label: &str) -> Vec<String> {
    let normalized = compact_app_text(label);
    let mut aliases = Vec::new();
    if [
        "safari",
        "googlechrome",
        "chrome",
        "firefox",
        "microsoftedge",
        "bravebrowser",
    ]
    .iter()
    .any(|name| normalized.contains(name))
    {
        aliases.extend(["browser".to_string(), "浏览器".to_string()]);
    }
    if normalized.contains("wechat") || normalized.contains("weixin") || normalized.contains("微信")
    {
        aliases.extend([
            "wechat".to_string(),
            "weixin".to_string(),
            "微信".to_string(),
        ]);
    }
    if normalized.contains("autocad")
        || normalized.contains("zwcad")
        || normalized.contains("gstarcad")
    {
        aliases.extend(["cad".to_string(), "CAD".to_string()]);
    }
    if normalized.contains("microsoftword") || normalized.contains("wpsoffice") {
        aliases.extend(["office".to_string(), "文档".to_string()]);
    }
    aliases
}

#[cfg(target_os = "macos")]
fn list_macos_native_apps(query: Option<&str>, limit: usize) -> Vec<NativeAppEntry> {
    let normalized_query = query.map(normalize_app_query).unwrap_or_default();
    let mut apps = Vec::new();
    let mut seen = HashSet::new();

    for (root, source, score) in macos_app_roots() {
        if !root.is_dir() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 3 || apps.len() >= 1500 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let is_bundle = path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| extension.eq_ignore_ascii_case("app"))
                    .unwrap_or(false);
                if is_bundle {
                    let label = path
                        .file_stem()
                        .map(|name| name.to_string_lossy().trim().to_string())
                        .unwrap_or_default();
                    if label.is_empty() {
                        continue;
                    }
                    let path_text = path.to_string_lossy().to_string();
                    let path_key = path_text.to_lowercase();
                    if !seen.insert(path_key) {
                        continue;
                    }
                    let aliases = macos_app_aliases(&label);
                    let label_key = compact_app_text(&label);
                    let matches_query = normalized_query.is_empty()
                        || label_key.contains(&normalized_query)
                        || normalized_query.contains(&label_key)
                        || aliases.iter().any(|alias| {
                            let alias_key = compact_app_text(alias);
                            alias_key == normalized_query || alias_key.contains(&normalized_query)
                        });
                    if matches_query {
                        apps.push(NativeAppEntry {
                            app_id: if label_key.is_empty() {
                                label.to_lowercase()
                            } else {
                                label_key
                            },
                            label,
                            path: path_text,
                            source: source.to_string(),
                            aliases,
                            score,
                        });
                    }
                    continue;
                }
                if depth < 3 && path.is_dir() {
                    stack.push((path, depth + 1));
                }
            }
        }
    }

    apps.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
    });
    apps.truncate(limit.clamp(1, 200));
    apps
}

#[cfg(target_os = "macos")]
fn should_try_macos_app_index(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.starts_with('.')
        || trimmed.contains("://")
        || trimmed.starts_with("mailto:")
    {
        return false;
    }
    true
}

#[cfg(target_os = "macos")]
fn try_launch_macos_app(target: &str) -> Option<CommandResult> {
    if !should_try_macos_app_index(target) {
        return None;
    }
    let app = list_macos_native_apps(Some(target), 1).into_iter().next()?;
    let output = Command::new("open").arg(&app.path).output();
    Some(match output {
        Ok(result) if result.status.success() => CommandResult {
            success: true,
            output: format!("Opened app {} ({})", app.label, app.path),
        },
        Ok(result) => CommandResult {
            success: false,
            output: String::from_utf8_lossy(&result.stderr).trim().to_string(),
        },
        Err(error) => CommandResult {
            success: false,
            output: error.to_string(),
        },
    })
}

#[cfg(target_os = "windows")]
fn looks_like_url(target: &str) -> bool {
    let lower = target.trim().to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || lower.starts_with("mailto:")
}

#[cfg(target_os = "windows")]
fn launchable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_lowercase().as_str(),
                "exe" | "bat" | "cmd" | "lnk" | "url"
            )
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn should_try_windows_app_index(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() || looks_like_url(trimmed) {
        return false;
    }

    let target_path = Path::new(trimmed);
    if target_path.exists() {
        return launchable_extension(target_path);
    }

    if trimmed.contains('\\')
        || trimmed.contains('/')
        || trimmed.contains(':')
        || trimmed.starts_with('.')
    {
        return false;
    }

    match target_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_lowercase().as_str(),
            "exe" | "bat" | "cmd" | "lnk" | "url"
        ),
        None => true,
    }
}

#[cfg(target_os = "windows")]
fn expand_windows_path_template(template: &str) -> Option<PathBuf> {
    let mut expanded = template.to_string();
    for (token, var) in [
        ("%ProgramFiles(x86)%", "ProgramFiles(x86)"),
        ("%ProgramFiles%", "ProgramFiles"),
        ("%LOCALAPPDATA%", "LOCALAPPDATA"),
        ("%APPDATA%", "APPDATA"),
        ("%USERPROFILE%", "USERPROFILE"),
        ("%PUBLIC%", "PUBLIC"),
        ("%WINDIR%", "WINDIR"),
    ] {
        if expanded.contains(token) {
            let value = std::env::var(var).ok()?;
            expanded = expanded.replace(token, &value);
        }
    }
    Some(PathBuf::from(expanded))
}

#[cfg(target_os = "windows")]
fn windows_app_search_roots() -> Vec<(PathBuf, &'static str, i32)> {
    let mut roots = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        roots.push((PathBuf::from(user_profile).join("Desktop"), "desktop", 130));
    }
    if let Ok(public_dir) = std::env::var("PUBLIC") {
        roots.push((
            PathBuf::from(public_dir).join("Desktop"),
            "public_desktop",
            110,
        ));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push((
            PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"),
            "user_start_menu",
            90,
        ));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        roots.push((
            PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "system_start_menu",
            80,
        ));
    }
    roots
}

#[cfg(target_os = "windows")]
fn filename_matches_app_definition(file_name: &str, def: &WindowsAppDefinition) -> bool {
    if def
        .executable_names
        .iter()
        .any(|name| file_name.eq_ignore_ascii_case(name))
    {
        return true;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    let name_norm = compact_app_text(file_name);
    let stem_norm = compact_app_text(stem);

    def.aliases.iter().any(|alias| {
        let alias_norm = normalize_app_query(alias);
        !alias_norm.is_empty()
            && (name_norm == alias_norm
                || stem_norm == alias_norm
                || (alias_norm.len() >= 3 && stem_norm.contains(&alias_norm)))
    })
}

#[cfg(target_os = "windows")]
fn app_query_matches_definition(query: &str, def: &WindowsAppDefinition) -> bool {
    let normalized = normalize_app_query(query);
    if normalized.is_empty() {
        return false;
    }
    if normalized == compact_app_text(def.app_id) || normalized == compact_app_text(def.label) {
        return true;
    }
    def.aliases
        .iter()
        .any(|alias| normalized == normalize_app_query(alias))
        || def
            .executable_names
            .iter()
            .any(|name| normalized == compact_app_text(name))
}

#[cfg(target_os = "windows")]
fn search_app_definitions<'a>(
    query: &str,
    definitions: &'a [WindowsAppDefinition],
) -> Vec<&'a WindowsAppDefinition> {
    let exact: Vec<_> = definitions
        .iter()
        .filter(|def| app_query_matches_definition(query, def))
        .collect();
    // Preserve complete names such as "Visual Studio Code" before considering
    // alternate keywords. This only broadens discovery, never direct launch.
    if !exact.is_empty() {
        return exact;
    }
    let terms: Vec<_> = query
        .split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '/' | ',' | '，' | '、' | ';' | '；' | '|' | '(' | ')' | '（' | '）'
                )
        })
        .filter(|term| !term.is_empty())
        .take(16)
        .map(normalize_app_query)
        .filter(|term| term.chars().count() >= 2)
        .collect();
    // Multiple different app aliases remain multiple candidates. Selection
    // and target verification stay with the existing open/execute boundary.
    definitions
        .iter()
        .filter(|def| {
            terms
                .iter()
                .any(|term| app_query_matches_definition(term, def))
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn app_args_for_path(app_id: &str, path: &Path) -> Vec<String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if app_id == "wechat" && file_name.eq_ignore_ascii_case("weixin.exe") {
        vec!["--scene=desktop".to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn candidate_from_path(
    def: &WindowsAppDefinition,
    path: PathBuf,
    source: &str,
    score: i32,
) -> WindowsLaunchCandidate {
    WindowsLaunchCandidate {
        app_id: def.app_id.to_string(),
        label: def.label.to_string(),
        args: app_args_for_path(def.app_id, &path),
        path,
        source: source.to_string(),
        aliases: def.aliases.iter().map(|alias| alias.to_string()).collect(),
        score,
    }
}

#[cfg(target_os = "windows")]
fn app_launch_history_path() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("LOCALAPPDATA"))
        .ok()?;
    Some(
        PathBuf::from(base)
            .join("LumiCore")
            .join("app-launch-history.json"),
    )
}

#[cfg(target_os = "windows")]
fn read_app_launch_history() -> Vec<AppLaunchHistoryEntry> {
    let Some(current_path) = app_launch_history_path() else {
        return Vec::new();
    };
    let path = if current_path.exists() {
        current_path
    } else {
        let Some(base) = current_path.parent().and_then(Path::parent) else {
            return Vec::new();
        };
        base.join("LumiOS").join("app-launch-history.json")
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<AppLaunchHistoryEntry>>(&raw).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn write_app_launch_history(history: &[AppLaunchHistoryEntry]) {
    let Some(path) = app_launch_history_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(history) {
        let _ = std::fs::write(path, raw);
    }
}

#[cfg(target_os = "windows")]
fn record_app_launch(candidate: &WindowsLaunchCandidate) {
    let mut history = read_app_launch_history();
    let path = candidate.path.to_string_lossy().to_string();
    history.retain(|entry| {
        !(entry.app_id == candidate.app_id && entry.path.eq_ignore_ascii_case(&path))
    });
    let last_success_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    history.insert(
        0,
        AppLaunchHistoryEntry {
            app_id: candidate.app_id.clone(),
            path,
            args: candidate.args.clone(),
            source: candidate.source.clone(),
            last_success_ms,
        },
    );
    if history.len() > 120 {
        history.truncate(120);
    }
    write_app_launch_history(&history);
}

#[cfg(target_os = "windows")]
fn history_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    read_app_launch_history()
        .into_iter()
        .filter(|entry| entry.app_id == def.app_id)
        .filter_map(|entry| {
            let path = PathBuf::from(&entry.path);
            if !path.exists() {
                return None;
            }
            Some(WindowsLaunchCandidate {
                app_id: def.app_id.to_string(),
                label: def.label.to_string(),
                path,
                args: entry.args,
                source: "history".to_string(),
                aliases: def.aliases.iter().map(|alias| alias.to_string()).collect(),
                score: 220,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn shortcut_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    for (root, source, score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1600 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if filename_matches_app_definition(file_name, def) {
                    candidates.push(candidate_from_path(def, path, source, score));
                }
            }
        }
        if !candidates.is_empty() {
            break;
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn shortcut_candidates_for_definitions(
    defs: &[WindowsAppDefinition],
) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    for (root, source, score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1600 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if let Some(def) = defs
                    .iter()
                    .find(|def| filename_matches_app_definition(file_name, def))
                {
                    candidates.push(candidate_from_path(def, path, source, score));
                }
            }
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn generic_windows_launch_candidates(query: Option<&str>) -> Vec<WindowsLaunchCandidate> {
    let normalized_query = query.map(normalize_app_query).unwrap_or_default();
    if query.is_some() && normalized_query.is_empty() {
        return Vec::new();
    }
    let query_is_specific = normalized_query.chars().count() >= 2;
    let mut candidates = Vec::new();
    for (root, source, base_score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1800 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let label = path
                    .file_stem()
                    .map(|value| value.to_string_lossy().trim().to_string())
                    .unwrap_or_default();
                let label_key = compact_app_text(&label);
                if label_key.is_empty() {
                    continue;
                }
                let exact_match = !normalized_query.is_empty() && label_key == normalized_query;
                let partial_match = query_is_specific && label_key.contains(&normalized_query);
                if !normalized_query.is_empty() && !exact_match && !partial_match {
                    continue;
                }
                candidates.push(WindowsLaunchCandidate {
                    app_id: label_key.clone(),
                    label: label.clone(),
                    path,
                    args: Vec::new(),
                    source: source.to_string(),
                    aliases: vec![label],
                    score: base_score
                        + if exact_match {
                            45
                        } else if partial_match {
                            15
                        } else {
                            0
                        },
                });
            }
        }
    }
    dedupe_windows_candidates(candidates)
}

#[cfg(target_os = "windows")]
fn fixed_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    def.fixed_paths
        .iter()
        .filter_map(|template| expand_windows_path_template(template))
        .filter(|path| path.exists())
        .map(|path| candidate_from_path(def, path, "known_path", 170))
        .collect()
}

#[cfg(target_os = "windows")]
fn dedupe_windows_candidates(
    mut candidates: Vec<WindowsLaunchCandidate>,
) -> Vec<WindowsLaunchCandidate> {
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| {
            let key = candidate.path.to_string_lossy().to_lowercase();
            seen.insert(key)
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    candidates.extend(history_candidates_for_definition(def));
    candidates.extend(fixed_candidates_for_definition(def));
    if candidates.is_empty() {
        candidates.extend(shortcut_candidates_for_definition(def));
    }
    dedupe_windows_candidates(candidates)
}

#[cfg(target_os = "windows")]
fn resolve_app_definition(target: &str) -> Option<WindowsAppDefinition> {
    if !should_try_windows_app_index(target) {
        return None;
    }
    windows_app_definitions()
        .into_iter()
        .find(|def| app_query_matches_definition(target, def))
}

#[cfg(target_os = "windows")]
fn native_app_entry_from_candidate(candidate: WindowsLaunchCandidate) -> NativeAppEntry {
    NativeAppEntry {
        app_id: candidate.app_id,
        label: candidate.label,
        path: candidate.path.to_string_lossy().to_string(),
        source: candidate.source,
        aliases: candidate.aliases,
        score: candidate.score,
    }
}

#[cfg(target_os = "windows")]
fn list_windows_native_apps(query: Option<&str>, limit: usize) -> Vec<NativeAppEntry> {
    let definitions = windows_app_definitions();
    let mut candidates = Vec::new();
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        for def in search_app_definitions(q, &definitions) {
            candidates.extend(candidates_for_definition(def));
        }
        candidates.extend(generic_windows_launch_candidates(Some(q)));
    } else {
        for def in &definitions {
            candidates.extend(history_candidates_for_definition(def));
            candidates.extend(fixed_candidates_for_definition(def));
        }
        candidates.extend(shortcut_candidates_for_definitions(&definitions));
        candidates.extend(generic_windows_launch_candidates(None));
    }
    dedupe_windows_candidates(candidates)
        .into_iter()
        .take(limit.clamp(1, 200))
        .map(native_app_entry_from_candidate)
        .collect()
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
pub(crate) struct RecentlyFocusedWindowsApp {
    pub(crate) hwnd: isize,
    pub(crate) pid: u32,
    pub(crate) title: String,
    pub(crate) recorded_at: Instant,
}

#[cfg(target_os = "windows")]
pub(crate) fn recently_focused_windows_app() -> &'static Mutex<Option<RecentlyFocusedWindowsApp>> {
    use std::sync::OnceLock;
    static RECENT: OnceLock<Mutex<Option<RecentlyFocusedWindowsApp>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn focus_running_windows_app(def: &WindowsAppDefinition) -> Option<CommandResult> {
    let executable_names: Vec<String> = def
        .executable_names
        .iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".exe"))
        .map(|name| name.to_ascii_lowercase())
        .collect();
    if executable_names.is_empty() {
        return None;
    }

    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let pids: Vec<u32> = sys
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let name = process.name().to_string_lossy().to_ascii_lowercase();
            if executable_names.iter().any(|expected| expected == &name) {
                Some(pid.as_u32())
            } else {
                None
            }
        })
        .collect();
    if pids.is_empty() {
        return None;
    }

    #[repr(C)]
    struct FocusSearch {
        pids: Vec<u32>,
        hwnd: isize,
        pid: u32,
        title: String,
    }

    extern "system" {
        fn EnumWindows(lpEnumFunc: extern "system" fn(isize, isize) -> i32, lParam: isize) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetWindowTextLengthW(hwnd: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, lpdwProcessId: *mut u32) -> u32;
        fn ShowWindow(hwnd: isize, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
    }

    extern "system" fn enum_window(hwnd: isize, lparam: isize) -> i32 {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }

            let state = &mut *(lparam as *mut FocusSearch);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if !state.pids.contains(&pid) {
                return 1;
            }

            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                return 1;
            }
            let mut buf: Vec<u16> = vec![0; title_len as usize + 1];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            state.hwnd = hwnd;
            state.pid = pid;
            state.title = String::from_utf16_lossy(&buf[..len as usize]);
            0
        }
    }

    let mut state = FocusSearch {
        pids,
        hwnd: 0,
        pid: 0,
        title: String::new(),
    };

    unsafe {
        EnumWindows(enum_window, &mut state as *mut FocusSearch as isize);
        if state.hwnd != 0 {
            const SW_RESTORE: i32 = 9;
            ShowWindow(state.hwnd, SW_RESTORE);
            if SetForegroundWindow(state.hwnd) == 0 {
                return Some(CommandResult {
                    success: false,
                    output: format!(
                        "Found running app {} (pid {}, window \"{}\") but Windows refused to focus it",
                        def.label, state.pid, state.title
                    ),
                });
            }
            if let Ok(mut recent) = recently_focused_windows_app().lock() {
                *recent = Some(RecentlyFocusedWindowsApp {
                    hwnd: state.hwnd,
                    pid: state.pid,
                    title: state.title.clone(),
                    recorded_at: Instant::now(),
                });
            }
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Focused running app {} (pid {}, window \"{}\")",
                    def.label, state.pid, state.title
                ),
            });
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn quote_windows_open_argument(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for current in value.chars() {
        if current == '\\' {
            slashes += 1;
            continue;
        }
        if current == '"' {
            quoted.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            quoted.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        quoted.push(current);
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(target_os = "windows")]
fn shell_open_windows(target: &str, args: &[String]) -> CommandResult {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> isize;
    }
    if target.is_empty()
        || target.chars().any(char::is_control)
        || args.iter().any(|arg| arg.chars().any(char::is_control))
    {
        return CommandResult {
            success: false,
            output: "Invalid open target or argument".to_string(),
        };
    }
    let wide = |value: &str| {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let operation = wide("open");
    let file = wide(target);
    let parameters = wide(
        &args
            .iter()
            .map(|arg| quote_windows_open_argument(arg))
            .collect::<Vec<_>>()
            .join(" "),
    );
    // The target is a separate native API parameter, never cmd.exe source text.
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            if args.is_empty() {
                std::ptr::null()
            } else {
                parameters.as_ptr()
            },
            std::ptr::null(),
            1,
        )
    };
    CommandResult {
        success: result > 32,
        output: if result > 32 {
            format!("Opened: {}", target)
        } else {
            format!("Windows could not open {} (error {})", target, result)
        },
    }
}

#[cfg(target_os = "windows")]
fn validate_windows_open_target(target: &str) -> Result<String, String> {
    if target.is_empty() || target.chars().any(char::is_control) {
        return Err("Invalid open target".to_string());
    }
    if Path::new(target).exists() {
        let absolute = std::fs::canonicalize(target).map_err(|error| error.to_string())?;
        let absolute = absolute.to_string_lossy();
        // Windows shell APIs expect ordinary DOS/UNC names, rather than Rust's
        // verbatim filesystem namespace returned by canonicalize.
        return Ok(if let Some(unc) = absolute.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{}", unc)
        } else {
            absolute
                .strip_prefix(r"\\?\")
                .unwrap_or(&absolute)
                .to_string()
        });
    }
    if let Ok(url) = tauri::Url::parse(target) {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
            return Ok(url.to_string());
        }
        if url.scheme() == "mailto" && !url.path().is_empty() {
            return Ok(url.to_string());
        }
    }
    Err("Open target must be an existing file or folder, an installed application, or an HTTP(S)/mailto URL".to_string())
}

#[cfg(target_os = "windows")]
#[cfg(test)]
mod windows_open_target_tests {
    use super::{quote_windows_open_argument, validate_windows_open_target};

    #[test]
    fn validates_supported_urls_without_launching_them() {
        for target in [
            "https://example.invalid/docs?a=1&b=2",
            "mailto:test@example.invalid",
        ] {
            assert!(validate_windows_open_target(target).is_ok(), "{}", target);
        }
        for target in [
            "",
            "unknown-protocol:example",
            "mailto:",
            "missing-file.txt",
            "https://example.invalid/\n",
        ] {
            assert!(
                validate_windows_open_target(target).is_err(),
                "{:?}",
                target
            );
        }
    }

    #[test]
    fn preserves_existing_file_names_as_one_native_target() {
        let target =
            std::env::temp_dir().join(format!("lumi-open-test-{}-a & b.txt", std::process::id()));
        std::fs::write(&target, "validation fixture").unwrap();
        let result = validate_windows_open_target(&target.to_string_lossy());
        std::fs::remove_file(&target).unwrap();
        let normalized = result.unwrap();
        assert!(normalized.ends_with("-a & b.txt"));
        assert!(!normalized.starts_with(r"\\?\"));
    }

    #[test]
    fn quotes_application_arguments_with_windows_backslash_rules() {
        assert_eq!(quote_windows_open_argument(""), "\"\"");
        assert_eq!(quote_windows_open_argument("a & b"), "\"a & b\"");
        assert_eq!(quote_windows_open_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            quote_windows_open_argument("C:\\directory with spaces\\"),
            "\"C:\\directory with spaces\\\\\""
        );
    }
}

#[cfg(target_os = "windows")]
fn launch_windows_path(path: &Path, extra_args: &[String]) -> CommandResult {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if matches!(extension.as_str(), "bat" | "cmd" | "lnk" | "url") {
        if matches!(extension.as_str(), "bat" | "cmd") && !extra_args.is_empty() {
            return CommandResult {
                success: false,
                output: "Script arguments require the command execution workflow".to_string(),
            };
        }
        return shell_open_windows(&path.to_string_lossy(), extra_args);
    }
    let spawned = {
        let mut cmd = Command::new(path);
        for arg in extra_args {
            cmd.arg(arg);
        }
        spawn_hidden(&mut cmd)
    };

    match spawned {
        Ok(_) => CommandResult {
            success: true,
            output: format!("Opened: {}", path.display()),
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[cfg(target_os = "windows")]
fn open_target_in_windows_application(application: &str, target: &str) -> Option<CommandResult> {
    let mut candidates = generic_windows_launch_candidates(Some(application));
    if candidates.is_empty() {
        if let Some(definition) = resolve_app_definition(application) {
            candidates = candidates_for_definition(&definition);
        }
    }
    if candidates.is_empty() {
        return Some(CommandResult {
            success: false,
            output: format!("No installed application matched: {}", application),
        });
    }

    let mut last_error = None;
    for candidate in candidates {
        let mut args = candidate.args.clone();
        args.push(target.to_string());
        let result = launch_windows_path(&candidate.path, &args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened {} in {} via {}",
                    target,
                    candidate.label,
                    candidate.path.display()
                ),
            });
        }
        last_error = Some(result.output);
    }
    Some(CommandResult {
        success: false,
        output: last_error
            .unwrap_or_else(|| format!("Failed to open {} in {}", target, application)),
    })
}

#[cfg(target_os = "macos")]
fn open_target_in_macos_application(application: &str, target: &str) -> Option<CommandResult> {
    let app = list_macos_native_apps(Some(application), 1)
        .into_iter()
        .next();
    let mut command = Command::new("open");
    if let Some(ref matched) = app {
        command.arg("-a").arg(&matched.path).arg(target);
    } else {
        command.args(["-a", application, target]);
    }
    Some(match command.output() {
        Ok(result) if result.status.success() => CommandResult {
            success: true,
            output: format!(
                "Opened {} in {}",
                target,
                app.map(|matched| matched.label)
                    .unwrap_or_else(|| application.to_string())
            ),
        },
        Ok(result) => CommandResult {
            success: false,
            output: decode_command_bytes(&result.stderr).trim().to_string(),
        },
        Err(error) => CommandResult {
            success: false,
            output: error.to_string(),
        },
    })
}

#[cfg(target_os = "windows")]
fn try_launch_windows_app_alias(target: &str) -> Option<CommandResult> {
    let def = resolve_app_definition(target)?;
    if let Some(result) = focus_running_windows_app(&def) {
        return Some(result);
    }
    let candidates = candidates_for_definition(&def);
    if candidates.is_empty() {
        return Some(CommandResult {
            success: false,
            output: format!(
                "No local app entry found for {}. Checked launch history, Desktop, Start Menu, and known install paths.",
                def.label
            ),
        });
    }

    let mut last_error: Option<String> = None;
    for candidate in candidates {
        let result = launch_windows_path(&candidate.path, &candidate.args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened app {} via {} ({})",
                    candidate.label,
                    candidate.path.display(),
                    candidate.source
                ),
            });
        }
        last_error = Some(result.output);
    }

    Some(CommandResult {
        success: false,
        output: last_error.unwrap_or_else(|| format!("Failed to open {}", def.label)),
    })
}

#[cfg(target_os = "windows")]
fn try_launch_generic_windows_app(target: &str) -> Option<CommandResult> {
    if !should_try_windows_app_index(target) {
        return None;
    }
    let candidates = generic_windows_launch_candidates(Some(target));
    if candidates.is_empty() {
        return None;
    }
    let mut last_error = None;
    for candidate in candidates {
        let result = launch_windows_path(&candidate.path, &candidate.args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened app {} via {} ({})",
                    candidate.label,
                    candidate.path.display(),
                    candidate.source
                ),
            });
        }
        last_error = Some(result.output);
    }
    Some(CommandResult {
        success: false,
        output: last_error.unwrap_or_else(|| format!("Failed to open {}", target)),
    })
}

#[tauri::command]
pub(crate) async fn list_native_apps(
    query: Option<String>,
    limit: Option<usize>,
) -> Vec<NativeAppEntry> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            list_windows_native_apps(query.as_deref(), limit.unwrap_or(80))
        })
        .await
        .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            list_macos_native_apps(query.as_deref(), limit.unwrap_or(80))
        })
        .await
        .unwrap_or_default();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = query;
        let _ = limit;
        Vec::new()
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn is_web_url_target(target: &str) -> bool {
    let normalized = target.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
}

#[cfg(test)]
mod web_target_identity_tests {
    #[test]
    fn website_targets_never_enter_application_or_desktop_file_search() {
        for value in [
            "https://chat.deepseek.com/",
            "HTTP://www.douyin.com/",
            " https://example.com/a.txt ",
        ] {
            assert!(super::is_web_url_target(value));
        }
        for value in [
            "deepseek.txt",
            "Google Chrome",
            r"C:\test\deepseek.txt",
            "https-not-a-url",
        ] {
            assert!(!super::is_web_url_target(value));
        }
    }
}

#[tauri::command]
pub(crate) fn open_item(
    target: String,
    application: Option<String>,
    window: tauri::WebviewWindow,
) -> CommandResult {
    // Open file, folder, app, or URL with the OS default handler
    let _ = window.set_always_on_top(false);

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let mut target = target;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if let Some(application) = application
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        #[cfg(target_os = "windows")]
        if let Some(result) = open_target_in_windows_application(&application, &target) {
            return result;
        }

        #[cfg(target_os = "macos")]
        if let Some(result) = open_target_in_macos_application(&application, &target) {
            return result;
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = application;

    #[cfg(target_os = "windows")]
    if let Some(result) = (!is_web_url_target(&target))
        .then(|| try_launch_windows_app_alias(&target))
        .flatten()
    {
        return result;
    }

    #[cfg(target_os = "windows")]
    if let Some(result) = (!is_web_url_target(&target))
        .then(|| try_launch_generic_windows_app(&target))
        .flatten()
    {
        return result;
    }

    #[cfg(target_os = "macos")]
    if let Some(result) = (!is_web_url_target(&target))
        .then(|| try_launch_macos_app(&target))
        .flatten()
    {
        if result.success {
            return result;
        }
        eprintln!(
            "[LumiCore] indexed macOS app launch failed, keeping LaunchServices fallbacks: {}",
            result.output
        );
    }

    #[cfg(target_os = "macos")]
    if !is_web_url_target(&target) && should_try_macos_app_index(&target) {
        // Ask LaunchServices by registered application name before retaining the
        // legacy direct `open <target>` behavior below. This also covers apps
        // installed outside the directories indexed by Lumi.
        if let Ok(output) = Command::new("open").args(["-a", &target]).output() {
            if output.status.success() {
                return CommandResult {
                    success: true,
                    output: format!("Opened registered app: {}", target),
                };
            }
        }
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if !is_web_url_target(&target) && !Path::new(&target).exists() {
        if let Some(resolved) = resolve_desktop_item_fuzzy(&target) {
            target = resolved.to_string_lossy().to_string();
        }
    }

    #[cfg(target_os = "windows")]
    {
        match validate_windows_open_target(&target) {
            Ok(target) => shell_open_windows(&target, &[]),
            Err(error) => CommandResult {
                success: false,
                output: error,
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg(&target).output()
    } else {
        Command::new("xdg-open").arg(&target).output()
    };
    #[cfg(not(target_os = "windows"))]
    match result {
        Ok(out) => {
            if out.status.success() {
                return CommandResult {
                    success: true,
                    output: format!("Opened: {}", target),
                };
            }

            let stderr = decode_command_bytes(&out.stderr).trim().to_string();
            let stdout = decode_command_bytes(&out.stdout).trim().to_string();
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("Open command failed for: {}", target)
            };
            CommandResult {
                success: false,
                output: detail,
            }
        }
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
#[cfg(not(test))]
pub(crate) fn pick_directory(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let _ = window.set_always_on_top(false);
    let picked = window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .transpose()?;
    Ok(picked)
}

#[tauri::command]
#[cfg(test)]
pub(crate) fn pick_directory(_window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    Ok(None)
}
