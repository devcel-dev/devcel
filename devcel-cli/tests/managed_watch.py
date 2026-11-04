#!/usr/bin/env python3
"""Real-process automatic-server/lease integration checks (no engine or Studio needed).

Usage: python3 managed_watch.py /path/to/devcel EMPTY_EVIDENCE_DIR
The manual `serve` client uses the same P2PManager path as Studio. All projects,
registries and logs live in the isolated evidence directory; kill() only targets
Popen handles created by this test, never a PID file or process-name search.
"""
import concurrent.futures
import json
import itertools
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import sys
import threading
import time

CLI = str(Path(sys.argv[1]).resolve())
ROOT = Path(sys.argv[2]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
assert not any(ROOT.iterdir()), "Use a new empty evidence directory"
HOME = ROOT / "home"
HOME.mkdir()
ENV = {**os.environ, "HOME": str(HOME), "APPDATA": str(HOME),
       "DEVCEL_P2P_SESSION_DIR": str(HOME / "sessions")}
commands = []
processes = []
process_ids = itertools.count()
results = []


def run(*args, ok=True):
    p = subprocess.run([CLI, *map(str, args)], env=ENV, text=True, capture_output=True, timeout=20)
    r = json.loads(p.stdout)
    commands.append({"args": list(map(str, args)), "exit": p.returncode, "response": r})
    (ROOT / "commands.json").write_text(json.dumps(commands, indent=2))
    assert (p.returncode == 0 and r.get("ok") is True) == ok, (args, r, p.stderr)
    return r.get("data", r)


class Process:
    def __init__(self, *args, pass_fds=()):
        self.name = f"process-{next(process_ids):03}"
        self.log = open(ROOT / (self.name + ".stderr"), "w")
        options = {"pass_fds": pass_fds} if os.name == "posix" else {}
        self.p = subprocess.Popen([CLI, *map(str, args)], env=ENV, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, **options)
        self.lines = queue.Queue()
        self.output = []
        processes.append(self)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            value = json.loads(line)
            self.output.append(value)
            self.lines.put(value)
            (ROOT / (self.name + ".json")).write_text(json.dumps(self.output, indent=2))

    def event(self, name, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                value = self.lines.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if value.get("event") == name:
                return value
            assert value.get("ok") is not False, value
        raise AssertionError((self.name, name, self.p.poll(), self.output))

    def eof(self):
        if self.p.stdin and not self.p.stdin.closed:
            self.p.stdin.close()
        assert self.p.wait(timeout=3) == 0, self.output

    def stop(self):
        if self.p.poll() is None:
            if os.name == "posix":
                self.p.send_signal(signal.SIGINT)
            else:
                self.p.terminate()
            self.p.wait(timeout=10)

    def crash(self):
        self.p.kill()
        self.p.wait(timeout=3)


def watch(project):
    return Process("--project", project, "watch", "--ensure-server", "--parent-stdin")


def status(project):
    return run("--project", project, "status")


def await_status(project, expected, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = status(project)
        if info["server_running"] == expected:
            return info
        time.sleep(.15)
    raise AssertionError((project, expected, info))


def registry(project):
    files = list(HOME.rglob("*.json"))
    for path in files:
        data = json.loads(path.read_text())
        expected = str(project.resolve())
        if os.name == "nt":
            expected = expected.removeprefix("\\\\?\\").replace("\\", "/")
        if data.get("project_path") == expected:
            return path, data
    raise AssertionError("Missing registry")


def one_server(project):
    _, data = registry(project)
    active = [s for s in data["services"] if s["status"] == "Active"]
    assert len(active) == 1, data
    return active[0]


def passed(name):
    results.append(name)
    (ROOT / "results.json").write_text(json.dumps({"passed": results}, indent=2))
    print(name, flush=True)


try:
    help_text = subprocess.check_output([CLI, "watch", "--help"], text=True, env=ENV)
    assert "--ensure-server" in help_text and "--parent-stdin" in help_text
    alpha = Path(run("init", "Alpha", "--dir", ROOT)["project_path"])
    beta = Path(run("init", "Beta", "--dir", ROOT)["project_path"])
    run("--project", alpha, "table", "create", "Items")
    run("--project", alpha, "watch", ok=False)
    passed("opt-in help and watch without server")

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        watchers = list(pool.map(lambda _: watch(alpha), range(8)))
        other = list(pool.map(lambda _: watch(beta), range(2)))
    addresses = [w.event("connected")["server"] for w in watchers]
    other_addresses = [w.event("connected")["server"] for w in other]
    assert len(set(addresses)) == len(set(other_addresses)) == 1
    assert addresses[0] != other_addresses[0]
    assert one_server(alpha)["app_type"] == "devcel-importer"
    one_server(beta)
    passed("8 simultaneous leases share one server; independent projects use separate servers")

    run("--project", alpha, "--mode", "client", "column", "add", "Items", "power", "I32")
    for w in watchers:
        while "power" not in json.dumps(w.event("snapshot")["project_state"]):
            pass
    run("--project", alpha, "--mode", "client", "column", "add", "Items", "label", "String")
    for w in watchers:
        while "label" not in json.dumps(w.event("snapshot")["project_state"]):
            pass
    passed("schema updates broadcast committed snapshots to every watcher")

    for w in watchers[:-1]:
        w.eof()
    time.sleep(5.7)
    assert status(alpha)["address"] == addresses[0]
    watchers[-1].crash()
    await_status(alpha, False)
    assert status(beta)["address"] == other_addresses[0]
    for w in other:
        w.eof()
    await_status(beta, False)
    passed("partial release preserves authority; crashed final watcher releases; projects independent")

    manual = Process("--project", alpha, "serve")
    external = await_status(alpha, True)["address"]
    w = watch(alpha)
    assert w.event("connected")["server"] == external
    w.eof()
    time.sleep(5.7)
    assert status(alpha)["address"] == external and manual.p.poll() is None
    manual.stop()
    await_status(alpha, False)
    passed("external manual server reused and never stopped by importer release")

    w = watch(alpha)
    managed_address = w.event("connected")["server"]
    editor = Process("--project", alpha, "serve")
    # Wait for the manager's full project synchronization and client registration.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if any(isinstance(s["status"], dict) and "Client" in s["status"] for s in registry(alpha)[1]["services"]):
            break
        time.sleep(.05)
    else:
        raise AssertionError("Manual/Studio manager did not join")
    w.eof()
    time.sleep(5.7)
    assert status(alpha)["address"] == managed_address and editor.p.poll() is None
    run("--project", alpha, "--mode", "client", "column", "add", "Items", "after_release", "I32")
    editor.stop()
    await_status(alpha, False)
    passed("Studio-path client keeps managed authority and edits alive after all importers leave")

    managed = Process("--project", alpha, "__serve-managed")
    await_status(alpha, True)
    w = watch(alpha)
    w.event("connected")
    managed.crash()
    w.event("disconnected")
    assert w.p.wait(timeout=3) == 0
    successor = watch(alpha)
    successor.event("connected")
    one_server(alpha)
    successor.eof()
    await_status(alpha, False)
    passed("server crash releases OS lock and new watcher reacquires without stale-PID cleanup")

    for iteration in range(3):
        w = watch(alpha)
        address = w.event("connected")["server"]
        w.eof()
        time.sleep(.4)
        reloaded = watch(alpha)
        assert reloaded.event("connected")["server"] == address
        reloaded.eof()
        await_status(alpha, False)
    passed("three complete on/off cycles and reload grace reuse")

    early = watch(beta)
    early.eof()
    time.sleep(.3)
    await_status(beta, False)
    passed("parent stdin EOF during acquisition exits promptly without persistent orphan")

    if os.name == "posix":
        first = watch(alpha)
        first.event("connected")
        leaked = first.p.stdin.fileno()
        os.set_inheritable(leaked, True)
        second = Process("--project", beta, "watch", "--ensure-server", "--parent-stdin", pass_fds=(leaked,))
        second.event("connected")
        first.eof()
        await_status(alpha, False)
        assert second.p.poll() is None and status(beta)["server_running"]
        second.eof()
        await_status(beta, False)
        passed("inherited sibling stdin writer is closed before runtime; first source EOF is not retained")

    invalid = ROOT / "Invalid.devcelproj.toml"
    invalid.write_text("not a project = [")
    started = time.monotonic()
    invalid_result = run("--project", invalid, "watch", "--ensure-server", ok=False)
    assert time.monotonic() - started < 5
    assert "startup failed" in invalid_result["error"]["text"].lower()
    assert "timed out" not in invalid_result["error"]["text"].lower()
    passed("invalid project startup returns original error promptly")

    # Occupy the preferred project port after a prior authority has stopped.
    preferred = int(addresses[0].rsplit(":", 1)[1])
    blocker = socket.socket()
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    blocker.bind(("127.0.0.1", preferred))
    blocker.listen()
    w = watch(alpha)
    assert int(w.event("connected")["server"].rsplit(":", 1)[1]) != preferred
    saved_service = one_server(alpha)
    w.eof()
    await_status(alpha, False)
    blocker.close()
    passed("unrelated occupied preferred port falls back without touching its listener")

    manual = Process("--project", beta, "serve")
    raced = [watch(beta) for _ in range(4)]
    race_addresses = [w.event("connected")["server"] for w in raced]
    assert len(set(race_addresses)) == 1
    one_server(beta)
    for w in raced:
        w.eof()
    assert manual.p.poll() is None
    manual.stop()
    await_status(beta, False)
    passed("manual/Studio startup races share one authority with automatic startup")

    for boundary in (4.85, 5.05):
        w = watch(alpha)
        w.event("connected")
        w.eof()
        time.sleep(boundary)
        raced = watch(alpha)
        raced.event("connected")
        one_server(alpha)
        raced.eof()
        await_status(alpha, False)
    passed("connection at both sides of idle-shutdown boundary reacquires safely")

    beta_watch = watch(beta)
    beta_address = beta_watch.event("connected")["server"]
    path, data = registry(alpha)
    wrong = dict(saved_service)
    wrong["address"] = beta_address
    data["services"] = [wrong]
    path.write_text(json.dumps(data))
    recovered = watch(alpha)
    assert recovered.event("connected")["server"] != beta_address
    assert status(beta)["address"] == beta_address
    one_server(alpha)
    recovered.eof()
    beta_watch.eof()
    await_status(alpha, False)
    await_status(beta, False)
    passed("stale address reused by another Devcel project recovers without touching that authority")

    # A stale entry pointing at a non-Devcel listener must not emit connected
    # or start a second authority. Hold sockets open to exercise handshake timeout.
    fake = socket.socket()
    fake.bind(("127.0.0.1", 0))
    fake.listen()
    fake.settimeout(.1)
    stop_fake = threading.Event()
    accepted = []
    def accept_fake():
        while not stop_fake.is_set():
            try:
                conn, _ = fake.accept()
                accepted.append(conn)
            except socket.timeout:
                pass
    thread = threading.Thread(target=accept_fake, daemon=True)
    thread.start()
    path, data = registry(alpha)
    saved_service["address"] = f"127.0.0.1:{fake.getsockname()[1]}"
    data["services"] = [saved_service]
    path.write_text(json.dumps(data))
    mismatch = watch(alpha)
    assert mismatch.p.wait(timeout=12) == 1
    assert not any(line.get("event") == "connected" for line in mismatch.output)
    # Use an app-created private capability from our own crashed listener. The
    # fake endpoint can now hold a real mutual handshake pending without ever
    # receiving a secret or manufacturing a permissive capability file.
    donor = Process("--project", beta, "serve")
    donor_info = await_status(beta, True)
    donor_port = int(donor_info["address"].rsplit(":", 1)[1])
    donor.crash()
    fake_cap = HOME / "sessions" / f"{fake.getsockname()[1]}.cap"
    os.replace(HOME / "sessions" / f"{donor_port}.cap", fake_cap)
    interrupted = watch(alpha)
    time.sleep(.1)
    started = time.monotonic()
    interrupted.eof()
    assert time.monotonic() - started < 2
    fake_cap.unlink()
    stop_fake.set()
    thread.join(timeout=1)
    fake.close()
    for conn in accepted:
        conn.close()
    data["services"] = []
    path.write_text(json.dumps(data))
    passed("incompatible endpoint rejected; EOF cancels blocked handshake without waiting for timeout")

    assert not status(alpha)["server_running"] and not status(beta)["server_running"]
    print(json.dumps({"ok": True, "checks": len(results), "evidence": str(ROOT)}))
finally:
    for process in processes:
        if process.p.poll() is None:
            if process.p.stdin and not process.p.stdin.closed:
                process.p.stdin.close()
            try:
                process.p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.stop()
        process.log.close()
