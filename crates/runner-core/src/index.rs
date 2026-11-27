use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node, Parser, Tree};

const CACHE_VERSION: u32 = 1;
const SNIPPET_MAX_LINES: usize = 80;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    ".intentra",
    "target",
    "vendor",
];
const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lang {
    Ts,
    Tsx,
    Js,
    Jsx,
    Python,
    Go,
    Rust,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub end_line: u32,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndex {
    mtime_ns: u128,
    size: u64,
    sha256: String,
    lines: u32,
    symbols: Vec<Symbol>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    files: BTreeMap<String, FileIndex>,
}

#[derive(Debug, Default)]
pub struct Index {
    root: PathBuf,
    files: BTreeMap<String, FileIndex>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub path: String,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub content: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("path {0} is outside the workspace")]
    OutsideRoot(PathBuf),
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid search pattern: {0}")]
    Pattern(String),
    #[error("{0} is not a supported source file")]
    Unsupported(PathBuf),
}

fn lang_for(path: &Path) -> Option<Lang> {
    match path.extension()?.to_str()? {
        "ts" => Some(Lang::Ts),
        "tsx" => Some(Lang::Tsx),
        "js" | "mjs" | "cjs" => Some(Lang::Js),
        "jsx" => Some(Lang::Jsx),
        "py" => Some(Lang::Python),
        "go" => Some(Lang::Go),
        "rs" => Some(Lang::Rust),
        _ => None,
    }
}

fn is_source(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| SOURCE_EXTENSIONS.contains(&extension))
}

fn language(lang: Lang) -> Language {
    match lang {
        Lang::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Lang::Js | Lang::Jsx => tree_sitter_javascript::LANGUAGE.into(),
        Lang::Python => tree_sitter_python::LANGUAGE.into(),
        Lang::Go => tree_sitter_go::LANGUAGE.into(),
        Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
    }
}

fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    node.utf8_text(source.as_bytes()).unwrap_or("")
}

fn signature(node: Node<'_>, source: &str) -> String {
    let raw = text(node, source);
    let first = raw.lines().next().unwrap_or("").trim();
    first.chars().take(160).collect()
}

fn ancestor_kind(mut node: Node<'_>, kinds: &[&str]) -> bool {
    while let Some(parent) = node.parent() {
        if kinds.contains(&parent.kind()) {
            return true;
        }
        node = parent;
    }
    false
}

fn symbol_for(node: Node<'_>, source: &str, lang: Lang) -> Option<Symbol> {
    let kind = node.kind();
    let (name, symbol_kind) = match lang {
        Lang::Ts | Lang::Tsx | Lang::Js | Lang::Jsx => match kind {
            "function_declaration" | "generator_function_declaration" => {
                (node.child_by_field_name("name")?, "function")
            }
            "class_declaration" | "abstract_class_declaration" => {
                (node.child_by_field_name("name")?, "class")
            }
            "interface_declaration" => (node.child_by_field_name("name")?, "interface"),
            "type_alias_declaration" => (node.child_by_field_name("name")?, "type"),
            "enum_declaration" => (node.child_by_field_name("name")?, "enum"),
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                (node.child_by_field_name("name")?, "method")
            }
            "variable_declarator" => {
                let value = node.child_by_field_name("value")?;
                let symbol_kind = match value.kind() {
                    "arrow_function" | "function" | "function_expression" => "function",
                    "class" => "class",
                    _ => return None,
                };
                (node.child_by_field_name("name")?, symbol_kind)
            }
            _ => return None,
        },
        Lang::Python => match kind {
            "function_definition" => {
                let symbol_kind = if ancestor_kind(node, &["class_definition"]) {
                    "method"
                } else {
                    "function"
                };
                (node.child_by_field_name("name")?, symbol_kind)
            }
            "class_definition" => (node.child_by_field_name("name")?, "class"),
            _ => return None,
        },
        Lang::Go => match kind {
            "function_declaration" => (node.child_by_field_name("name")?, "function"),
            "method_declaration" => (node.child_by_field_name("name")?, "method"),
            "type_spec" => {
                let symbol_kind = node
                    .child_by_field_name("type")
                    .map(|type_node| match type_node.kind() {
                        "struct_type" => "struct",
                        "interface_type" => "interface",
                        _ => "type",
                    })
                    .unwrap_or("type");
                (node.child_by_field_name("name")?, symbol_kind)
            }
            _ => return None,
        },
        Lang::Rust => match kind {
            "function_item" => {
                let symbol_kind = if ancestor_kind(node, &["impl_item", "trait_item"]) {
                    "method"
                } else {
                    "function"
                };
                (node.child_by_field_name("name")?, symbol_kind)
            }
            "function_signature_item" => (node.child_by_field_name("name")?, "method"),
            "struct_item" => (node.child_by_field_name("name")?, "struct"),
            "union_item" => (node.child_by_field_name("name")?, "union"),
            "enum_item" => (node.child_by_field_name("name")?, "enum"),
            "trait_item" => (node.child_by_field_name("name")?, "trait"),
            "impl_item" => (node.child_by_field_name("type")?, "impl"),
            "const_item" => (node.child_by_field_name("name")?, "const"),
            "static_item" => (node.child_by_field_name("name")?, "static"),
            "type_item" => (node.child_by_field_name("name")?, "type"),
            "mod_item" => (node.child_by_field_name("name")?, "module"),
            "macro_definition" => (node.child_by_field_name("name")?, "macro"),
            _ => return None,
        },
    };
    Some(Symbol {
        name: name.utf8_text(source.as_bytes()).ok()?.to_string(),
        kind: symbol_kind.to_string(),
        line: node.start_position().row as u32 + 1,
        end_line: node.end_position().row as u32 + 1,
        signature: signature(node, source),
    })
}

fn extract_symbols(tree: &Tree, source: &str, lang: Lang) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    let mut cursor = tree.walk();
    let mut done = false;
    while !done {
        let node = cursor.node();
        if let Some(symbol) = symbol_for(node, source, lang) {
            symbols.push(symbol);
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                done = true;
                break;
            }
        }
    }
    symbols
}

fn cache_path(root: &Path, tree_hash: &str) -> PathBuf {
    root.join(crate::git::INTENTRA_DIR)
        .join("index")
        .join(format!("{tree_hash}.json"))
}

impl Index {
    pub fn build(root: &Path, tree_hash: &str) -> Result<Index, IndexError> {
        let root = root.canonicalize().map_err(|source| IndexError::Io {
            path: root.to_path_buf(),
            source,
        })?;
        let _ = crate::git::exclude_intentra(&root);
        let cache_file = cache_path(&root, tree_hash);
        let previous: BTreeMap<String, FileIndex> = std::fs::read_to_string(&cache_file)
            .ok()
            .and_then(|raw| serde_json::from_str::<CacheFile>(&raw).ok())
            .filter(|cache| cache.version == CACHE_VERSION)
            .map(|cache| cache.files)
            .unwrap_or_default();
        let mut files = BTreeMap::new();
        let mut parser = Parser::new();
        let mut current_lang: Option<Lang> = None;
        collect_files(&root, &mut |path| {
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let metadata = match std::fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(_) => return,
            };
            let mtime_ns = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let size = metadata.len();
            if let Some(cached) = previous.get(&relative)
                && cached.mtime_ns == mtime_ns
                && cached.size == size
            {
                files.insert(relative, cached.clone());
                return;
            }
            let bytes = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(_) => return,
            };
            let sha256 = crate::util::sha256_hex(&bytes);
            if let Some(cached) = previous.get(&relative)
                && cached.sha256 == sha256
            {
                {
                    files.insert(
                        relative,
                        FileIndex {
                            mtime_ns,
                            size,
                            sha256,
                            ..cached.clone()
                        },
                    );
                    return;
                }
            }
            let Some(lang) = lang_for(path) else {
                return;
            };
            let source = String::from_utf8_lossy(&bytes);
            if current_lang != Some(lang) {
                if parser.set_language(&language(lang)).is_err() {
                    return;
                }
                current_lang = Some(lang);
            }
            let Some(tree) = parser.parse(source.as_ref(), None) else {
                return;
            };
            files.insert(
                relative,
                FileIndex {
                    mtime_ns,
                    size,
                    sha256,
                    lines: source.lines().count() as u32,
                    symbols: extract_symbols(&tree, &source, lang),
                },
            );
        });
        if let Some(parent) = cache_file.parent() {
            let _ = std::fs::create_dir_all(parent);
            let cache = CacheFile {
                version: CACHE_VERSION,
                files: files.clone(),
            };
            if let Ok(raw) = serde_json::to_string(&cache) {
                let _ = std::fs::write(&cache_file, raw);
            }
        }
        Ok(Index { root, files })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn outline(&self, path: Option<&str>) -> Result<Vec<OutlineEntry>, IndexError> {
        let mut entries = Vec::new();
        for (relative, file) in &self.files {
            if let Some(filter) = path
                && !relative.contains(filter)
            {
                continue;
            }
            if file.symbols.is_empty() {
                continue;
            }
            entries.push(OutlineEntry {
                path: relative.clone(),
                symbols: file.symbols.clone(),
            });
        }
        Ok(entries)
    }

    pub fn search(&self, prefix: &str, limit: usize) -> Vec<SearchHit> {
        let needle = prefix.to_lowercase();
        let mut hits: Vec<SearchHit> = self
            .files
            .iter()
            .flat_map(|(path, file)| {
                file.symbols
                    .iter()
                    .filter(|symbol| symbol.name.to_lowercase().starts_with(&needle))
                    .map(|symbol| SearchHit {
                        path: path.clone(),
                        name: symbol.name.clone(),
                        kind: symbol.kind.clone(),
                        line: symbol.line,
                    })
            })
            .collect();
        hits.sort_by(|left, right| {
            left.name
                .len()
                .cmp(&right.name.len())
                .then(left.name.cmp(&right.name))
                .then(left.path.cmp(&right.path))
                .then(left.line.cmp(&right.line))
        });
        hits.truncate(limit);
        hits
    }

    pub fn grep(&self, pattern: &str, limit: usize) -> Result<Vec<GrepHit>, IndexError> {
        let regex = Regex::new(pattern).map_err(|error| IndexError::Pattern(error.to_string()))?;
        let mut hits = Vec::new();
        for relative in self.files.keys() {
            let path = self.root.join(relative);
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (index, line) in body.lines().enumerate() {
                if regex.is_match(line) {
                    hits.push(GrepHit {
                        path: relative.clone(),
                        line: index as u32 + 1,
                        text: line.chars().take(300).collect(),
                    });
                    if hits.len() >= limit {
                        return Ok(hits);
                    }
                }
            }
        }
        Ok(hits)
    }

    pub fn snippet(
        &self,
        relative: &str,
        start_line: Option<u32>,
        end_line: Option<u32>,
    ) -> Result<Snippet, IndexError> {
        let path = crate::util::resolve_inside(&self.root, relative).map_err(|source| {
            if source.kind() == std::io::ErrorKind::PermissionDenied {
                IndexError::OutsideRoot(self.root.join(relative))
            } else {
                IndexError::Io {
                    path: self.root.join(relative),
                    source,
                }
            }
        })?;
        if lang_for(&path).is_none() && !is_source(&path) {
            return Err(IndexError::Unsupported(path));
        }
        let body = std::fs::read_to_string(&path).map_err(|source| IndexError::Io {
            path: path.clone(),
            source,
        })?;
        let total = body.lines().count().max(1) as u32;
        let start = start_line.unwrap_or(1).clamp(1, total);
        let requested_end = end_line.unwrap_or(start + SNIPPET_MAX_LINES as u32 - 1);
        let end = requested_end
            .min(start + SNIPPET_MAX_LINES as u32 - 1)
            .clamp(start, total);
        let content = body
            .lines()
            .enumerate()
            .filter(|(index, _)| {
                let line = *index as u32 + 1;
                line >= start && line <= end
            })
            .map(|(index, line)| format!("{:>5} | {line}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(Snippet {
            path: relative.to_string(),
            start_line: start,
            end_line: end,
            content,
        })
    }
}

fn collect_files(root: &Path, visit: &mut impl FnMut(&Path)) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| IGNORED_DIRS.contains(&name))
            {
                continue;
            }
            collect_files(&path, visit);
        } else if file_type.is_file() && is_source(&path) {
            visit(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn extracts_symbols_from_every_supported_language() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "app.ts",
            "export function greet(name: string): string { return name; }\nclass Store { save() {} }\ninterface Row {}\n",
        );
        write(
            dir.path(),
            "tool.py",
            "def hello():\n    pass\n\nclass Keeper:\n    def method(self):\n        pass\n",
        );
        write(
            dir.path(),
            "main.go",
            "package main\n\nfunc Add(a int) int { return a }\n\ntype Row struct{}\n",
        );
        write(
            dir.path(),
            "lib.rs",
            "pub fn add(a: u32) -> u32 { a }\npub struct S;\nimpl S { fn new() -> Self { S } }\n",
        );
        write(
            dir.path(),
            "ignore/node_modules/x.ts",
            "export function hidden() {}\n",
        );
        let index = Index::build(dir.path(), "hash").unwrap();
        let names: Vec<String> = index
            .outline(None)
            .unwrap()
            .into_iter()
            .flat_map(|entry| entry.symbols.into_iter().map(|symbol| symbol.name))
            .collect();
        for expected in [
            "greet", "Store", "save", "Row", "hello", "Keeper", "method", "Add", "add", "S", "new",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing {expected} in {names:?}"
            );
        }
        assert!(!names.iter().any(|name| name == "hidden"));
    }

    #[test]
    fn search_grep_and_snippet_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let long = (1..=120)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        write(
            dir.path(),
            "lib.ts",
            &format!("export function target() {{}}\n{long}\n"),
        );
        let index = Index::build(dir.path(), "hash").unwrap();
        let hits = index.search("tar", 10);
        assert_eq!(hits[0].name, "target");
        let greps = index.grep(r"line 1\d\d", 10).unwrap();
        assert_eq!(greps.len(), 10);
        let snippet = index.snippet("lib.ts", Some(1), Some(500)).unwrap();
        assert_eq!(snippet.end_line - snippet.start_line + 1, 80);
        assert!(index.snippet("../etc/passwd", None, None).is_err());
    }

    #[test]
    fn the_cache_is_reused_and_invalidated_by_content() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "lib.ts", "export function one() {}\n");
        let first = Index::build(dir.path(), "tree").unwrap();
        let cache = cache_path(&dir.path().canonicalize().unwrap(), "tree");
        assert!(cache.is_file());
        write(dir.path(), "lib.ts", "export function two() {}\n");
        let second = Index::build(dir.path(), "tree").unwrap();
        assert!(!second.search("one", 10).iter().any(|hit| hit.name == "one"));
        assert_eq!(second.search("two", 10)[0].name, "two");
        assert_eq!(first.search("one", 10)[0].name, "one");
    }
}
