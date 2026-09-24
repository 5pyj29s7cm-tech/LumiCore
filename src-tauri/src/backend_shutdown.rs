use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct ShutdownState {
    running: bool,
    saved: bool,
    result: Option<Result<(), String>>,
}

/// Window close, tray quit and the quit command share one save operation.
/// Failures leave the gate retryable; no caller can turn "already running"
/// into permission to exit.
#[derive(Default)]
pub struct ShutdownBarrier {
    state: Mutex<ShutdownState>,
    completed: Condvar,
}

impl ShutdownBarrier {
    pub fn is_saved(&self) -> bool {
        self.state.lock().map(|state| state.saved).unwrap_or(false)
    }

    pub fn prevents_restart(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.running || state.saved)
            .unwrap_or(true)
    }

    pub fn run(&self, save: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.saved {
            return Ok(());
        }
        if state.running {
            while state.running {
                state = self
                    .completed
                    .wait(state)
                    .map_err(|error| error.to_string())?;
            }
            return state
                .result
                .clone()
                .unwrap_or_else(|| Err("Shutdown did not produce a save receipt".into()));
        }
        state.running = true;
        drop(state);
        let result = save();
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.running = false;
        state.saved = result.is_ok();
        state.result = Some(result.clone());
        self.completed.notify_all();
        result
    }
}

fn parse_save_receipt(raw: &[u8], expected_pid: u32) -> Result<(), String> {
    let header_end = raw
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or_else(|| "Backend shutdown response was incomplete".to_string())?;
    let headers = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "Backend shutdown response headers were invalid".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1));
    if status != Some("200") {
        return Err("Backend could not confirm saving. Pending data was retained; resolve the error and retry closing.".into());
    }
    let body: Value = serde_json::from_slice(&raw[header_end + 4..])
        .map_err(|_| "Backend shutdown did not return a valid save receipt".to_string())?;
    if body.get("ok").and_then(Value::as_bool) != Some(true)
        || body.get("status").and_then(Value::as_str) != Some("saved")
        || body.get("pid").and_then(Value::as_u64) != Some(u64::from(expected_pid))
    {
        return Err("Backend shutdown save receipt did not match the owned process".into());
    }
    Ok(())
}

/// Uses the existing native proof exchange, never a browser-supplied token or
/// arbitrary URL. The caller additionally binds expected_pid to its own Child.
pub fn request_backend_save(expected_pid: u32) -> Result<(), String> {
    let identity = crate::local_bootstrap::bootstrap_local_identity(None)?;
    let token = identity
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Native shutdown authentication is unavailable".to_string())?;
    let proof = identity
        .get("desktopSessionProof")
        .and_then(Value::as_str)
        .ok_or_else(|| "Native shutdown session proof is unavailable".to_string())?;
    if [token, proof]
        .iter()
        .any(|value| value.is_empty() || value.len() > 16 * 1024 || value.contains(['\r', '\n']))
    {
        return Err("Native shutdown credentials are invalid".into());
    }
    let port = std::env::var("PORT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().parse::<u16>())
        .transpose()
        .map_err(|_| "Backend port is invalid".to_string())?
        .unwrap_or(3000);
    if port == 0 {
        return Err("Backend port is invalid".into());
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| format!("Cannot reach backend to save before closing: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(45)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let body = serde_json::to_vec(&serde_json::json!({ "expectedPid": expected_pid }))
        .map_err(|error| error.to_string())?;
    let request = format!(
        "POST /api/runtime/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAuthorization: Bearer {token}\r\nX-Lumi-Desktop-Session: {proof}\r\n\r\n",
        body.len(),
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("Cannot send backend save request: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(65_537)
        .read_to_end(&mut response)
        .map_err(|error| {
            format!("Still waiting for backend save confirmation; closing was cancelled: {error}")
        })?;
    if response.len() > 65_536 {
        return Err("Backend save receipt exceeded its limit".into());
    }
    parse_save_receipt(&response, expected_pid)
}

#[cfg(test)]
mod tests {
    use super::{parse_save_receipt, ShutdownBarrier};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn requires_saved_receipt_from_the_owned_backend() {
        assert!(parse_save_receipt(
            b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"status\":\"saved\",\"pid\":42}",
            42
        )
        .is_ok());
        assert!(parse_save_receipt(
            b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"status\":\"saved\",\"pid\":41}",
            42
        )
        .is_err());
        assert!(parse_save_receipt(b"HTTP/1.1 503 Unavailable\r\n\r\n{\"ok\":true}", 42).is_err());
        assert!(
            parse_save_receipt(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"pid\":42}", 42).is_err()
        );
    }

    #[test]
    fn duplicate_quit_waits_for_the_same_save() {
        let barrier = Arc::new(ShutdownBarrier::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = barrier.clone();
        let worker = std::thread::spawn(move || {
            first.run(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();
        assert!(!barrier.is_saved());
        assert!(barrier.prevents_restart());
        let (done_tx, done_rx) = mpsc::channel();
        let second = barrier.clone();
        let duplicate = std::thread::spawn(move || {
            done_tx
                .send(second.run(|| panic!("must share first save")))
                .unwrap()
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_ok());
        assert!(done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_ok());
        duplicate.join().unwrap();
        assert!(barrier.is_saved());
    }

    #[test]
    fn failed_save_never_authorizes_exit_and_can_retry() {
        let barrier = ShutdownBarrier::default();
        assert!(barrier.run(|| Err("disk full".into())).is_err());
        assert!(!barrier.is_saved());
        assert!(!barrier.prevents_restart());
        assert!(barrier.run(|| Ok(())).is_ok());
        assert!(barrier.is_saved());
    }
}
