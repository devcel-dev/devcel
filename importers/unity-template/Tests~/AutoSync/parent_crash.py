"""Linux owner-crash check. Owns/reaps its test descendants; never scans /proc."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def check_parent_crash(dotnet, assembly, cli, work, environment=None):
    # Adopt the test watch after its .NET owner dies, so waitpid proves that it
    # really exits. /proc may belong to a different PID namespace in a sandbox.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("Cannot enable child subreaper for this isolated test")
    work.mkdir(parents=True)
    env = dict(os.environ if environment is None else environment)
    env["QA_ROOT"] = str(work)
    for key in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]:
        env[key] = str(work / key)
        Path(env[key]).mkdir()

    def cli_call(arguments):
        result = subprocess.run([str(cli), *arguments], env=env, text=True,
                                capture_output=True, timeout=20, check=True)
        return json.loads(result.stdout)["data"]

    project = cli_call(["init", "Crash", "--dir", str(work)])["project_path"]
    parent = subprocess.Popen([str(dotnet), str(assembly), str(cli), "lease", project],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    watch_pid = None
    watch_reaped = False
    try:
        import selectors
        with selectors.DefaultSelector() as ready:
            ready.register(parent.stdout, selectors.EVENT_READ)
            if not ready.select(25):
                raise AssertionError("The test owner did not establish its watch within 25 seconds")
        line = parent.stdout.readline()
        assert line.startswith("WATCH_PID="), line
        watch_pid = int(line.split("=", 1)[1])
        assert cli_call(["-p", project, "status"])["server_running"]
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            reaped, _ = os.waitpid(watch_pid, os.WNOHANG)
            if reaped == watch_pid:
                watch_reaped = True
                break
            time.sleep(0.1)
        assert watch_reaped, "watch survived owner SIGKILL"
        print("PASS owner SIGKILL closes stdin; actual watch exit verified with waitpid")
        deadline = time.monotonic() + 12
        while cli_call(["-p", project, "status"])["server_running"] and time.monotonic() < deadline:
            time.sleep(0.25)
        assert not cli_call(["-p", project, "status"])["server_running"]
        print("PASS managed server stops after owner crash releases final demand")
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if watch_pid is not None and not watch_reaped:
            # Only the test child we created, never a shared server/process tree.
            try:
                os.kill(watch_pid, signal.SIGKILL)
                os.waitpid(watch_pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        # Reap any managed-server descendants already shut down normally.
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
