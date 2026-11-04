//! Dependency-free, session-authenticated loopback importer UI.
//! Only configured runtime files are served. There is no general filesystem server.
use devcel_core::importer_pull::{self, PullConfig};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::Command,
    time::Duration,
};

const UI: &str = include_str!("importer_ui.html");
const LIMIT: usize = 1024 * 1024;

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
    token: String,
}
fn read_request(stream: &mut TcpStream, authority: &str) -> Result<Request, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let end = loop {
        let mut part = [0; 4096];
        let n = stream.read(&mut part).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Incomplete request".into());
        }
        bytes.extend_from_slice(&part[..n]);
        if bytes.len() > LIMIT {
            return Err("Request too large".into());
        }
        if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..end]).map_err(|e| e.to_string())?;
    let mut lines = headers.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" {
        return Err("Invalid request".into());
    }
    let method = parts[0].to_string();
    let target = parts[1].to_string();
    let mut host = None;
    let mut length = None;
    let mut token = String::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or("Invalid header")?;
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                if host.replace(value).is_some() {
                    return Err("Duplicate host".into());
                }
            }
            "origin" => {
                if value != format!("http://{authority}") {
                    return Err("Foreign origin".into());
                }
            }
            "content-length" => {
                if length
                    .replace(value.parse::<usize>().map_err(|_| "Invalid length")?)
                    .is_some()
                {
                    return Err("Duplicate length".into());
                }
            }
            "transfer-encoding" => return Err("Transfer encoding unsupported".into()),
            "x-devcel-token" => token = value.to_string(),
            _ => {}
        }
    }
    if host != Some(authority) {
        return Err("Invalid host".into());
    }
    let length = length.unwrap_or(0);
    if length > LIMIT - end {
        return Err("Request too large".into());
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    if token.is_empty() {
        token = query
            .split('&')
            .find_map(|part| part.strip_prefix("token="))
            .unwrap_or("")
            .to_string();
    }
    let path = path.to_string();
    while bytes.len() < end + length {
        let mut part = [0; 4096];
        let n = stream.read(&mut part).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Incomplete body".into());
        }
        bytes.extend_from_slice(&part[..n]);
    }
    Ok(Request {
        method,
        path,
        body: bytes[end..end + length].to_vec(),
        token,
    })
}
fn response(stream: &mut TcpStream, status: u16, kind: &str, body: &[u8]) {
    let headers = format!("HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\r\n", body.len());
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}
fn handle(root: &Path, engine: &str, request: &Request) -> Result<Value, String> {
    let config_path = root.join("devcel.import.json");
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/config") => {
            let (config, revision) = if config_path.exists() {
                let bytes = fs::read(&config_path).map_err(|e| e.to_string())?;
                let revision = format!("{:x}", Sha256::digest(&bytes));
                (
                    serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?,
                    revision,
                )
            } else {
                (
                    json!({"schema_version":1,"sources":[]}),
                    "missing".to_string(),
                )
            };
            Ok(json!({"engine":engine,"root":root,"config":config,"revision":revision}))
        }
        ("POST", "/api/tags") => {
            let input: Value = serde_json::from_slice(&request.body).map_err(|e| e.to_string())?;
            let project = input
                .get("project")
                .and_then(Value::as_str)
                .ok_or("Missing project")?;
            if project.is_empty()
                || Path::new(project).is_absolute()
                || !project.ends_with(".devcelproj.toml")
            {
                return Err("Choose a project path relative to the game project folder.".into());
            }
            // Only project registry metadata is returned, never table contents or a general file read.
            let text = fs::read_to_string(root.join(project)).map_err(|e| e.to_string())?;
            let data: devcel_core::project_impl::ProjectFileData =
                toml::from_str(&text).map_err(|e| format!("Invalid project metadata: {e}"))?;
            Ok(json!({"presets": data.tag_presets}))
        }
        ("POST", "/api/config") => {
            let input: Value = serde_json::from_slice(&request.body).map_err(|e| e.to_string())?;
            let config: PullConfig =
                serde_json::from_value(input.get("config").cloned().ok_or("Missing config")?)
                    .map_err(|e| e.to_string())?;
            let expected = input
                .get("revision")
                .and_then(Value::as_str)
                .ok_or("Missing revision")?;
            if config
                .sources
                .iter()
                .any(|s| Path::new(&s.project).is_absolute())
            {
                return Err("Specify the project path relative to the game project folder.".into());
            }
            let revision =
                importer_pull::save_config_if_revision(&config_path, &config, Some(expected))
                    .map_err(|e| e.to_string())?;
            Ok(json!({"saved":true,"revision":revision}))
        }
        ("POST", "/api/pull") | ("POST", "/api/status") => {
            let input: Value = serde_json::from_slice(&request.body).map_err(|e| e.to_string())?;
            let source = input.get("source").and_then(Value::as_str);
            let status = request.path == "/api/status";
            let report =
                importer_pull::run(&config_path, source, status).map_err(|e| e.to_string())?;
            if !report.success {
                return Err(serde_json::to_string(&report).map_err(|e| e.to_string())?);
            }
            let wolf = if engine == "wolf" && !status {
                Some(crate::wolf_export::export(&config_path, source)?)
            } else {
                None
            };
            Ok(json!({"report":report,"wolf":wolf}))
        }
        ("GET", path) if path.starts_with("/runtime/") => {
            let id = &path[9..];
            let config =
                importer_pull::validated_config(&config_path).map_err(|e| e.to_string())?;
            let source = config
                .sources
                .iter()
                .find(|s| s.id == id)
                .ok_or("Unknown source")?;
            // A runtime path is explicitly configured and fully validated; never accept a path from HTTP.
            serde_json::from_slice(&fs::read(&source.runtime_out).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        }
        _ => Err("Unknown endpoint".into()),
    }
}

pub fn serve(root: &Path, engine: &str, port: u16, open: bool) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Specify the game project folder".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    let authority = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("http://{authority}/#{token}");
    println!(
        "{}",
        json!({"ok":true,"data":{"url":url,"engine":engine,"root":root,"runtime_url":format!("http://{authority}/runtime/SOURCE_ID?token={token}")}})
    );
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    if open {
        #[cfg(target_os = "windows")]
        let result = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        #[cfg(target_os = "macos")]
        let result = Command::new("open").arg(&url).spawn();
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let result = Command::new("xdg-open").arg(&url).spawn();
        if let Err(error) = result {
            eprintln!("Could not open the browser. Open the displayed URL: {error}");
        }
    }
    for connection in listener.incoming() {
        let mut stream = connection.map_err(|e| e.to_string())?;
        match read_request(&mut stream, &authority) {
            Ok(request) if request.method == "GET" && request.path == "/" => {
                response(&mut stream, 200, "text/html; charset=utf-8", UI.as_bytes())
            }
            Ok(request) if request.method == "GET" && request.path == "/ui.js" => response(
                &mut stream,
                200,
                "text/javascript; charset=utf-8",
                include_bytes!("importer_ui.js"),
            ),
            Ok(request) if request.method == "GET" && request.path == "/tag-filters.js" => {
                response(
                    &mut stream,
                    200,
                    "text/javascript; charset=utf-8",
                    include_bytes!("importer_tag_filters.js"),
                )
            }
            Ok(request) if request.token == token => match handle(&root, engine, &request) {
                Ok(result) => response(
                    &mut stream,
                    200,
                    "application/json",
                    serde_json::to_vec(&result)
                        .map_err(|e| e.to_string())?
                        .as_slice(),
                ),
                Err(error) => response(
                    &mut stream,
                    400,
                    "application/json",
                    json!({"error":error}).to_string().as_bytes(),
                ),
            },
            _ => response(
                &mut stream,
                403,
                "application/json",
                b"{\"error\":\"Request rejected\"}",
            ),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_tags_are_relative_and_isolated() {
        let root = std::env::temp_dir().join(format!("devcel-ui-tags-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let read = |project: &str| {
            handle(
                &root,
                "wolf",
                &Request {
                    method: "POST".into(),
                    path: "/api/tags".into(),
                    token: String::new(),
                    body: serde_json::to_vec(&json!({"project":project})).unwrap(),
                },
            )
        };
        for (file, tags) in [
            ("A.devcelproj.toml", vec!["release".to_string()]),
            ("B.devcelproj.toml", vec!["mobile".to_string()]),
        ] {
            let data = devcel_core::project_impl::ProjectFileData {
                tag_presets: tags,
                ..Default::default()
            };
            fs::write(root.join(file), toml::to_string(&data).unwrap()).unwrap();
        }
        assert_eq!(
            read("A.devcelproj.toml").unwrap(),
            json!({"presets":["release"]})
        );
        assert_eq!(
            read("B.devcelproj.toml").unwrap(),
            json!({"presets":["mobile"]})
        );
        assert!(read(root.join("A.devcelproj.toml").to_str().unwrap()).is_err());
        assert!(read("A.txt").is_err());
        assert!(read("missing.devcelproj.toml").is_err());
        fs::write(root.join("B.devcelproj.toml"), "not valid metadata").unwrap();
        assert!(read("B.devcelproj.toml").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
