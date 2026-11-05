"""Source-contract checks, supplementary to the process integration harness."""
from pathlib import Path


def audit():
    root = Path(__file__).resolve().parents[2] / "Editor"
    watch = (root / "DevcelCliWatchProcess.cs").read_text()
    changes = (root / "DevcelChangeWatcher.cs").read_text()
    settings = (root / "DevcelImporterSettings.cs").read_text()
    runner = (root / "DevcelCliRunner.cs").read_text()
    ui = (root / "DevcelImporterWindow.cs").read_text()
    checks = {
        "Auto field default": "public DevcelSyncMode syncMode = DevcelSyncMode.Auto;" in settings,
        "enum storage identities": all(value in settings for value in ["Off = 0", "FileWatch = 1", "P2P = 2", "Auto = 3"]),
        "current settings schema retained": "SettingsSchemaVersion = 1" in settings,
        "direct automatic watch flags": "watch --ensure-server --parent-stdin" in watch,
        "no status subprocess preprobe": "StatusReply" not in watch and '+ " status"' not in watch,
        "stdin redirected and explicitly closed": "RedirectStandardInput = true" in watch and "Process.StandardInput.Close()" in watch,
        "only own process killed": "Process.Kill();" in watch and "Kill(true)" not in watch and "GetProcesses" not in watch,
        "no unbounded wait": "Process.WaitForExit();" not in watch,
        "watch bounded acquisition": "ConnectionTimeout = 15" in watch,
        "bounded exponential retries": "MaximumRetryDelay = 30" in watch and "Math.Pow(2" in watch,
        "flaps do not reset backoff": "StableConnectionPeriod = 30" in watch,
        "error summary follows discriminant": all('error?.kind == "' + kind + '"' in watch for kind in ["text", "code", "input_validation", "diagnostics"]),
        "Off rebuild early return": "if (settings.syncMode == DevcelSyncMode.Off) return;" in changes,
        "only Auto/P2P start process": "if (settings.syncMode == DevcelSyncMode.P2P || settings.syncMode == DevcelSyncMode.Auto)" in changes,
        "reload and exit cleanup": "beforeAssemblyReload += DisposeWatchers" in changes and "quitting += DisposeWatchers" in changes,
        "strict P2P connected gate": "P2P?.Connected != true) continue;" in changes,
        "fallback error visible": "DevcelChangeWatcher.GetError(project)" in ui,
        "current bundled capability verified": 'Run("watch --help"' in runner and 'Contains("--ensure-server")' in runner and 'Contains("--parent-stdin")' in runner,
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise AssertionError("Static contracts failed: " + ", ".join(failed))
    return checks


if __name__ == "__main__":
    print(f"PASS {len(audit())} static contract checks")
