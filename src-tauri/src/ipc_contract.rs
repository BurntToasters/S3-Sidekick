//! Generates `src/generated/ipc-contract.ts` from the registered Tauri
//! commands and fails when the checked-in file has drifted.
//!
//! Regenerate: `UPDATE_IPC_CONTRACT=1 cargo test ipc_contract`.
//!
// Failure modes this guards, written before the generator:
// - A command is renamed or removed in Rust while the webview still calls
//   the old name; the call fails only at runtime.
// - A parameter is renamed, added, or made required; the webview keeps
//   sending the old argument object.
// - Tauri camelCases argument keys; a contract built from raw snake_case
//   names would accept keys the backend never reads.
// - Injected parameters (State, AppHandle, Window) leak into the contract.
// - A command registered in `generate_handler!` is not found by the parser
//   (for example behind a new attribute form) and silently goes unchecked.
// - Platform-specific duplicates of one command disagree on parameters.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const INJECTED_TYPES: &[&str] = &["State", "AppHandle", "Window", "Webview", "WebviewWindow"];

fn source_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn contract_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("generated")
        .join("ipc-contract.ts")
}

fn is_command_attr(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr
        .path()
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect();
    segments == ["tauri", "command"]
}

fn camel_case(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in name.trim_start_matches('_').chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn last_segment(ty: &syn::Type) -> Option<&syn::PathSegment> {
    match ty {
        syn::Type::Path(path) => path.path.segments.last(),
        syn::Type::Reference(reference) => last_segment(&reference.elem),
        _ => None,
    }
}

fn generic_arg(segment: &syn::PathSegment) -> Option<&syn::Type> {
    match &segment.arguments {
        syn::PathArguments::AngleBracketed(args) => args.args.iter().find_map(|arg| match arg {
            syn::GenericArgument::Type(ty) => Some(ty),
            _ => None,
        }),
        _ => None,
    }
}

/// TypeScript type for a deserialized argument. Structs map to `unknown`:
/// the contract pins names and presence, and those shapes stay with their
/// hand-written interfaces.
fn ts_type(ty: &syn::Type) -> String {
    let Some(segment) = last_segment(ty) else {
        return "unknown".to_string();
    };
    match segment.ident.to_string().as_str() {
        "String" | "str" | "PathBuf" => "string".to_string(),
        "bool" => "boolean".to_string(),
        "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" | "f32"
        | "f64" => "number".to_string(),
        "Vec" => match generic_arg(segment).map(ts_type) {
            Some(inner) if inner.contains(' ') => format!("({})[]", inner),
            Some(inner) => format!("{}[]", inner),
            None => "unknown[]".to_string(),
        },
        "Option" => generic_arg(segment)
            .map(ts_type)
            .unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

fn is_option(ty: &syn::Type) -> bool {
    last_segment(ty).is_some_and(|segment| segment.ident == "Option")
}

#[derive(Debug, PartialEq)]
struct Arg {
    key: String,
    ts: String,
    optional: bool,
}

fn command_args(function: &syn::ItemFn) -> Vec<Arg> {
    function
        .sig
        .inputs
        .iter()
        .filter_map(|input| match input {
            syn::FnArg::Typed(typed) => Some(typed),
            syn::FnArg::Receiver(_) => None,
        })
        .filter(|typed| {
            last_segment(&typed.ty)
                .is_none_or(|segment| !INJECTED_TYPES.contains(&segment.ident.to_string().as_str()))
        })
        .map(|typed| {
            let name = match typed.pat.as_ref() {
                syn::Pat::Ident(ident) => ident.ident.to_string(),
                _ => panic!("command parameters must be plain identifiers"),
            };
            Arg {
                key: camel_case(&name),
                ts: ts_type(&typed.ty),
                optional: is_option(&typed.ty),
            }
        })
        .collect()
}

fn collect_commands(items: &[syn::Item], out: &mut BTreeMap<String, Vec<Arg>>) {
    for item in items {
        match item {
            syn::Item::Fn(function) if function.attrs.iter().any(is_command_attr) => {
                let name = function.sig.ident.to_string();
                let args = command_args(function);
                if let Some(existing) = out.get(&name) {
                    assert_eq!(
                        existing, &args,
                        "platform variants of command `{}` disagree on parameters",
                        name
                    );
                }
                out.insert(name, args);
            }
            syn::Item::Mod(module) if module.ident != "tests" => {
                if let Some((_, items)) = &module.content {
                    collect_commands(items, out);
                }
            }
            _ => {}
        }
    }
}

/// Command names listed in `generate_handler![...]`, last path segment only.
pub(crate) fn registered_commands(main_source: &str) -> Vec<String> {
    let start = main_source
        .find("generate_handler![")
        .expect("main.rs registers commands with generate_handler!");
    let body = &main_source[start + "generate_handler![".len()..];
    let end = body.find(']').expect("generate_handler! list is closed");
    let mut names: Vec<String> = body[..end]
        .split(',')
        .map(|path| {
            path.trim()
                .rsplit("::")
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names
}

fn render(commands: &BTreeMap<String, Vec<Arg>>) -> String {
    let mut out = String::from(
        "// Generated from the registered Tauri commands by\n\
         // src-tauri/src/ipc_contract.rs. Do not edit by hand.\n\
         // Regenerate: UPDATE_IPC_CONTRACT=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_contract\n\
         \n\
         /** Argument object each native command accepts, keyed by command. */\n\
         export interface IpcCommandArgs {\n",
    );
    for (name, args) in commands {
        if args.is_empty() {
            out.push_str(&format!("  {}: Record<never, never>;\n", name));
            continue;
        }
        out.push_str(&format!("  {}: {{\n", name));
        for arg in args {
            let (mark, ts) = if arg.optional {
                ("?", format!("{} | null", arg.ts))
            } else {
                ("", arg.ts.clone())
            };
            out.push_str(&format!("    {}{}: {};\n", arg.key, mark, ts));
        }
        out.push_str("  };\n");
    }
    out.push_str("}\n\nexport type IpcCommand = keyof IpcCommandArgs;\n");
    out
}

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read source directory") {
        let path = entry.expect("directory entry").path();
        if path.is_dir() {
            collect_rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn ipc_contract_matches_registered_commands() {
    let dir = source_dir();
    let mut commands = BTreeMap::new();
    let mut entries = Vec::new();
    collect_rust_files(&dir, &mut entries);
    entries.sort();
    for path in entries {
        let source = std::fs::read_to_string(&path).expect("read Rust source");
        let file = syn::parse_file(&source)
            .unwrap_or_else(|err| panic!("parse {}: {}", path.display(), err));
        collect_commands(&file.items, &mut commands);
    }

    let main_source = std::fs::read_to_string(dir.join("main.rs")).expect("read main.rs");
    let registered = registered_commands(&main_source);
    let missing: Vec<&String> = registered
        .iter()
        .filter(|name| !commands.contains_key(*name))
        .collect();
    assert!(
        missing.is_empty(),
        "registered commands the contract parser could not find: {:?}",
        missing
    );
    commands.retain(|name, _| registered.contains(name));

    let rendered = render(&commands);
    let path = contract_path();
    if std::env::var("UPDATE_IPC_CONTRACT").is_ok_and(|value| value == "1") {
        std::fs::create_dir_all(path.parent().expect("contract directory"))
            .expect("create src/generated");
        std::fs::write(&path, &rendered).expect("write IPC contract");
        return;
    }
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        current == rendered,
        "src/generated/ipc-contract.ts is out of date with the Rust commands. \
         Regenerate: UPDATE_IPC_CONTRACT=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_contract"
    );
}

#[test]
fn contract_keys_follow_tauri_camel_case() {
    assert_eq!(camel_case("connection_id"), "connectionId");
    assert_eq!(camel_case("src_prefix"), "srcPrefix");
    assert_eq!(camel_case("path"), "path");
}
