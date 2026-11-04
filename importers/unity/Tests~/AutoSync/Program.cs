using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Collections.Generic;
using System.Text.Json;
using Devcel.Unity.Editor;
using UnityEditor;
class Program
{
    static int checks;
    static string Root = Environment.GetEnvironmentVariable("QA_ROOT");
    static void Check(bool b, string name)
    {
        if (!b)
            throw new Exception("FAIL " + name);
        checks++;
        Console.WriteLine("PASS " + name);
    }
    static T Field<T>(object o, string n) => (T)o.GetType().GetField(n, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(o);
    static void Pump(DevcelCliWatchProcess p, double now, int ms = 160)
    {
        var c = Stopwatch.StartNew();
        do
        {
            p.Tick(now);
            Thread.Sleep(10);
        } while (c.ElapsedMilliseconds < ms);
    }
    static int WatchPid(DevcelCliWatchProcess p)
    {
        var c = Field<object>(p, "watch");
        return ((Process)c.GetType().GetField("Process").GetValue(c)).Id;
    }
    static bool Alive(int pid)
    {
        try
        {
            return !Process.GetProcessById(pid).HasExited;
        }
        catch (ArgumentException) { return false; }
    }
    static DevcelImporterSettings Settings()
    {
        AssetDatabase.Saved = null;
        typeof(DevcelImporterSettings).GetField("_instance", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, null);
        return DevcelImporterSettings.Instance;
    }
    static void Main(string[] args)
    {
        try { RunMain(args); }
        catch (Exception ex)
        {
            // Unwind using/finally blocks before reporting a failed integration check.
            Console.Error.WriteLine(ex);
            Environment.ExitCode = 1;
        }
    }
    static void RunMain(string[] args)
    {
        Directory.CreateDirectory(Root);
        DevcelPaths.Root = Root;
        DevcelPaths.CliPath = args[0];
        if (args.Length > 1 && args[1] == "real")
        {
            Real();
            return;
        }
        if (args.Length > 1 && args[1] == "lease")
        {
            Lease(args[2]);
            return;
        }
        Fake();
        Console.WriteLine("TOTAL " + checks);
    }
    static void Fake()
    {
        var settings = Settings();
        Check(settings.syncMode == DevcelSyncMode.Auto, "new settings default Auto");
        Check((int)DevcelSyncMode.Off == 0 && (int)DevcelSyncMode.FileWatch == 1 && (int)DevcelSyncMode.P2P == 2 && (int)DevcelSyncMode.Auto == 3, "serialized enum identities retained");
        settings.syncMode = DevcelSyncMode.Off;
        settings.Save();
        typeof(DevcelImporterSettings).GetField("_instance", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, null);
        Check(DevcelImporterSettings.Instance.syncMode == DevcelSyncMode.Off, "loading saved Off is not overwritten (mock asset store)");
        Check(DevcelCliRunner.ValidateBundledCli(out var error), "bundled version/pull/watch capabilities validated: " + error);
        string weird = Root + "/space and quote\" tail\\";
        var one = new DevcelCliWatchProcess(weird);
        int changes = 0;
        one.Changed += () => changes++;
        Pump(one, 0, 300);
        Check(one.Connected, "watch connects without status preprobe");
        Check(changes == 2, "connected catches up and snapshot triggers change");
        int pid = WatchPid(one);
        var starts = File.ReadAllLines(Root + "/starts.jsonl").Select(x => JsonDocument.Parse(x)).ToArray();
        Check(starts.Any(x => x.RootElement.GetProperty("project").GetString() == weird), "space/quote/trailing backslash arguments roundtrip");
        using (var two = new DevcelCliWatchProcess(Root + "/healthy"))
        {
            Pump(two, 0, 220);
            int second = WatchPid(two);
            one.Dispose();
            one.Dispose();
            Check(!Alive(pid), "Dispose stops own watch idempotently");
            Pump(two, .4, 100);
            Check(two.Connected && Alive(second), "disposing one watcher preserves the other");
            Check(File.ReadAllText(Root + "/eof.jsonl").Contains(pid.ToString()), "Dispose signals graceful stdin EOF");
        }
        using (var fail = new DevcelCliWatchProcess(Root + "/failure"))
        {
            double now = 0;
            double[] expected = { 1, 2, 4, 8, 16, 30, 30 };
            foreach (double delay in expected)
            {
                Pump(fail, now, 170);
                Check(!fail.Connected && Field<object>(fail, "watch") == null, "failed watch released");
                double next = Field<double>(fail, "nextAttempt");
                Check(Math.Abs(next - now - delay) < .0001, "retry delay " + delay);
                int start = DevcelPaths.Starts;
                fail.Tick(next - .01);
                Check(start == DevcelPaths.Starts, "no retry before backoff");
                now = next;
            }
            Check(fail.LastError.Contains("fixture bind denied") && fail.LastError.Contains("30 seconds") && !fail.LastError.Contains("\"ok\"") && fail.LastError.Length < 400, "UI shows concise cause and retry, not raw JSON");
            Check(UnityEngine.Debug.Logs.Any(x => x.Contains("stderr detail preserved") && x.Contains("\"ok\"")), "Console preserves typed JSON and stderr");
        }
        using (var hang = new DevcelCliWatchProcess(Root + "/hang"))
        {
            Pump(hang, 0, 120);
            int pid2 = WatchPid(hang);
            hang.Tick(15);
            Check(!hang.Connected && hang.LastError.Contains("15 seconds"), "startup has 15-second deadline");
            Check(!Alive(pid2), "timed out child stopped");
            int start = DevcelPaths.Starts;
            hang.Tick(15.9);
            Check(start == DevcelPaths.Starts, "startup timeout uses backoff");
            hang.Tick(16);
            Check(start + 1 == DevcelPaths.Starts, "startup timeout retries");
        }
        using (var flap = new DevcelCliWatchProcess(Root + "/flap"))
        {
            Pump(flap, 0, 200);
            Check(Field<int>(flap, "failures") == 1, "first flap records failure");
            Pump(flap, 1, 200);
            Check(Field<int>(flap, "failures") == 2 && Field<double>(flap, "nextAttempt") == 3, "brief connected events do not reset exponential backoff");
        }
        using (var healthy = new DevcelCliWatchProcess(Root + "/healthy"))
        {
            Pump(healthy, 0, 200);
            typeof(DevcelCliWatchProcess).GetField("failures", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(healthy, 4);
            healthy.Tick(31);
            Check(Field<int>(healthy, "failures") == 0, "stable connection resets backoff");
            int child = WatchPid(healthy);
            Process.GetProcessById(child).Kill();
            Thread.Sleep(50);
            Pump(healthy, 32, 150);
            Check(!healthy.Connected && healthy.LastError != null, "unexpected watch crash schedules retry");
            Pump(healthy, 33, 200);
            Check(healthy.Connected, "unexpected watch crash recovers");
        }
        DevcelPaths.Failure = "fixture manifest hash mismatch";
        using (var broken = new DevcelCliWatchProcess(Root + "/healthy"))
        {
            broken.Tick(0);
            Check(broken.LastError.Contains("hash mismatch"), "CLI preparation failure is visible");
            int start = DevcelPaths.Starts;
            broken.Tick(.8);
            Check(DevcelPaths.Starts == start, "broken bundle avoids busy retry");
            DevcelPaths.Failure = null;
            Pump(broken, 1, 200);
            Check(broken.Connected, "repaired package resumes on retry");
        }
        Watchers();
    }
    static void Watchers()
    {
        var s = Settings();
        s.debounceMs = 0;
        var a = new DevcelProjectConfig { projectName = "A", devcelProjectPath = Root + "/sourceA" };
        var b = new DevcelProjectConfig { projectName = "B", devcelProjectPath = Root + "/sourceB" };
        Directory.CreateDirectory(a.devcelProjectPath);
        Directory.CreateDirectory(b.devcelProjectPath);
        s.projects.Add(a);
        s.projects.Add(b);
        s.syncMode = DevcelSyncMode.Off;
        DevcelChangeWatcher.Rebuild();
        int before = DevcelPaths.Starts;
        EditorApplication.Tick();
        Check(before == DevcelPaths.Starts && DevcelChangeWatcher.GetStatus(a) == "Stopped", "Off launches no watch");
        s.syncMode = DevcelSyncMode.FileWatch;
        DevcelChangeWatcher.Rebuild();
        File.WriteAllText(a.devcelProjectPath + "/edit.table.toml", "a");
        Thread.Sleep(140);
        EditorApplication.Tick();
        Check(before == DevcelPaths.Starts && DevcelExporter.Exports.Contains("A") && !DevcelExporter.Exports.Contains("B"), "FileWatch imports only changed source and never starts server");
        s.syncMode = DevcelSyncMode.Auto;
        DevcelChangeWatcher.Rebuild();
        for (int i = 0; i < 30; i++)
        {
            EditorApplication.Tick();
            Thread.Sleep(10);
        }
        Check(DevcelChangeWatcher.GetStatus(a) == "P2P connected" && DevcelChangeWatcher.GetStatus(b) == "P2P connected", "Auto starts one watcher per registered source");
        Check(DevcelExporter.Exports.Contains("B"), "connection catchup preserves multi-source imports");
        a.autoSync = false;
        DevcelChangeWatcher.Rebuild();
        for (int i = 0; i < 20; i++)
        {
            EditorApplication.Tick();
            Thread.Sleep(10);
        }
        Check(DevcelChangeWatcher.GetStatus(a) == "Stopped" && DevcelChangeWatcher.GetStatus(b) == "P2P connected", "source autoSync opt-out preserves other source");
        AssemblyReloadEvents.Reload();
        Check(DevcelChangeWatcher.GetStatus(b) == "Stopped", "assembly reload disposes watcher subscriptions");
        DevcelChangeWatcher.Rebuild();
        for (int i = 0; i < 20; i++)
        {
            EditorApplication.Tick();
            Thread.Sleep(10);
        }
        EditorApplication.Quit();
        Check(DevcelChangeWatcher.GetStatus(b) == "Stopped", "Editor quit disposes watchers");
        var f = new DevcelProjectConfig { projectName = "Failure", devcelProjectPath = Root + "/failure" };
        Directory.CreateDirectory(f.devcelProjectPath);
        s.projects.Clear();
        s.projects.Add(f);
        s.syncMode = DevcelSyncMode.P2P;
        DevcelChangeWatcher.Rebuild();
        for (int i = 0; i < 30; i++)
        {
            EditorApplication.Tick();
            Thread.Sleep(10);
        }
        int exports = DevcelExporter.Exports.Count;
        File.WriteAllText(f.devcelProjectPath + "/a.table.toml", "data");
        Thread.Sleep(100);
        EditorApplication.Tick();
        Check(DevcelExporter.Exports.Count == exports && !DevcelChangeWatcher.GetStatus(f).Contains("FileWatch"), "strict P2P never imports files while disconnected");
        s.syncMode = DevcelSyncMode.Auto;
        DevcelChangeWatcher.Rebuild();
        for (int i = 0; i < 30; i++)
        {
            EditorApplication.Tick();
            Thread.Sleep(10);
        }
        File.WriteAllText(f.devcelProjectPath + "/a.table.toml", "new data");
        Thread.Sleep(100);
        EditorApplication.Tick();
        Check(DevcelExporter.Exports.Count > exports && DevcelChangeWatcher.GetStatus(f).Contains("FileWatch"), "Auto keeps file fallback during acquisition failure");
        Check(DevcelChangeWatcher.GetError(f).Contains("fixture bind denied"), "Auto exposes connection failure beside fallback status");
        s.syncMode = DevcelSyncMode.Off;
        DevcelChangeWatcher.Rebuild();
        exports = DevcelExporter.Exports.Count;
        File.WriteAllText(f.devcelProjectPath + "/a.table.toml", "after Off");
        Thread.Sleep(100);
        EditorApplication.Tick();
        Check(exports == DevcelExporter.Exports.Count, "Off removes pending and future file notifications");
    }
    static string Run(string args)
    {
        var r = DevcelCliRunner.Run(args);
        if (!r.Ok)
            throw new Exception(args + "\n" + r.Error + "\n" + r.Stderr);
        return r.Stdout;
    }
    static string Prefix(string p) => "--project " + DevcelCliRunner.QuoteArgument(p) + " ";
    static string Address(string p)
    {
        using var j = JsonDocument.Parse(Run(Prefix(p) + "status"));
        var data = j.RootElement.GetProperty("data");
        return data.GetProperty("server_running").GetBoolean() ? data.GetProperty("address").GetString() : null;
    }
    static void Until(Func<bool> ready, Action tick, int timeout = 18000)
    {
        var c = Stopwatch.StartNew();
        while (!ready())
        {
            if (c.ElapsedMilliseconds > timeout)
                throw new Exception("Timeout waiting for condition");
            tick();
            Thread.Sleep(20);
        }
    }
    static void Lease(string project)
    {
        var clock = Stopwatch.StartNew();
        var p = new DevcelCliWatchProcess(project);
        Until(() => p.Connected, () => p.Tick(clock.Elapsed.TotalSeconds));
        Console.WriteLine("WATCH_PID=" + WatchPid(p));
        Console.Out.Flush();
        while (true)
        {
            p.Tick(clock.Elapsed.TotalSeconds);
            Thread.Sleep(20);
        }
    }
    static void Real()
    {
        foreach (var v in new[] { "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME" })
        {
            string p = Root + "/" + v;
            Directory.CreateDirectory(p);
            Environment.SetEnvironmentVariable(v, p);
        }
        Check(DevcelCliRunner.ValidateBundledCli(out var error), "actual bundled CLI capability checks: " + error);
        Run("init Alpha --dir " + DevcelCliRunner.QuoteArgument(Root));
        Run("init Beta --dir " + DevcelCliRunner.QuoteArgument(Root));
        string a = Root + "/Alpha/Alpha.devcelproj.toml", b = Root + "/Beta/Beta.devcelproj.toml";
        Check(Address(a) == null && Address(b) == null, "projects begin without servers");
        var clock = Stopwatch.StartNew();
        double Now() => clock.Elapsed.TotalSeconds;
        using var one = new DevcelCliWatchProcess(a);
        using var two = new DevcelCliWatchProcess(a);
        using var other = new DevcelCliWatchProcess(b);
        int changedA = 0, changedB = 0;
        one.Changed += () => changedA++;
        other.Changed += () => changedB++;
        void Tick()
        {
            one.Tick(Now());
            two.Tick(Now());
            other.Tick(Now());
        }
        Until(() => one.Connected && two.Connected && other.Connected, Tick);
        Check(changedA >= 1 && changedB >= 1, "real watchers automatically acquire servers and catch up");
        string addrA = Address(a), addrB = Address(b);
        Check(addrA != null && addrB != null && addrA != addrB, "different source projects have separate servers");
        int before = changedA;
        Run(Prefix(a) + "table create items");
        Until(() => changedA > before, Tick);
        Check(changedB == 1, "real committed snapshot reaches only affected source");
        Run(Prefix(a) + "column add items title String");
        Run(Prefix(a) + "record add items");
        Run(Prefix(b) + "table create enemies");
        Thread.Sleep(1000);
        Tick();
        var config = new
        {
            schema_version = 1,
            sources = new[] { new { id = "alpha", project = a, @namespace = "Game.Alpha", class_name = "AlphaData", runtime_out = Root + "/outA/master.json", code_out = Root + "/outA/Devcel.cs", code_target = "csharp", mode = "full" }, new { id = "beta", project = b, @namespace = "Game.Beta", class_name = "BetaData", runtime_out = Root + "/outB/master.json", code_out = Root + "/outB/Devcel.cs", code_target = "csharp", mode = "full" } }
        };
        string manifest = Root + "/devcel.import.json";
        File.WriteAllText(manifest, JsonSerializer.Serialize(config));
        Run("pull --config " + DevcelCliRunner.QuoteArgument(manifest));
        string codeA = File.ReadAllText(Root + "/outA/Devcel.cs"), codeB = File.ReadAllText(Root + "/outB/Devcel.cs"), bundleA = File.ReadAllText(Root + "/outA/master.json");
        Check(codeA.Contains("AlphaData") && codeA.Contains("Game.Alpha") && codeB.Contains("BetaData"), "real multi-source pull preserves namespace and root class");
        Run(Prefix(a) + "column add items hp I32");
        Thread.Sleep(1000);
        Tick();
        Run("pull --config " + DevcelCliRunner.QuoteArgument(manifest) + " --source alpha");
        string schemaA = File.ReadAllText(Root + "/outA/Devcel.cs");
        Check(schemaA != codeA && File.ReadAllText(Root + "/outB/Devcel.cs") == codeB, "schema mutation regenerates only affected source code");
        string schemaBundle = File.ReadAllText(Root + "/outA/master.json");
        Run(Prefix(a) + "record add items");
        Thread.Sleep(1000);
        Tick();
        Run("pull --config " + DevcelCliRunner.QuoteArgument(manifest) + " --source alpha");
        Check(File.ReadAllText(Root + "/outA/Devcel.cs") == schemaA && File.ReadAllText(Root + "/outA/master.json") != schemaBundle, "data-only mutation updates bundle without rewriting schema code");
        int pid1 = WatchPid(one);
        one.Dispose();
        Tick();
        Check(!Alive(pid1) && two.Connected && Address(a) == addrA, "real watcher release preserves shared server for second client");
        int pid2 = WatchPid(two);
        Process.GetProcessById(pid2).Kill();
        Until(() => !two.Connected, Tick);
        Until(() => two.Connected, Tick);
        Check(WatchPid(two) != pid2 && Address(a) == addrA, "crashed watch reconnects within server reload grace");
        two.Dispose();
        Thread.Sleep(7500);
        Check(Address(a) == null, "managed server stops after final watch releases demand");
        Check(other.Connected && Address(b) == addrB, "stopping one project does not stop another source");
        other.Dispose();
        Thread.Sleep(7500);
        Check(Address(b) == null, "second project server also stops after final release");
        Run("init Manual --dir " + DevcelCliRunner.QuoteArgument(Root));
        string manualProject = Root + "/Manual/Manual.devcelproj.toml";
        using (var manual = new Process { StartInfo = new ProcessStartInfo { FileName = DevcelPaths.CliPath, Arguments = Prefix(manualProject) + "serve", UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true } })
        {
            manual.OutputDataReceived += (_, e) => { };
            manual.ErrorDataReceived += (_, e) => { };
            manual.Start();
            manual.BeginOutputReadLine();
            manual.BeginErrorReadLine();
            try
            {
                Until(() => Address(manualProject) != null, () => { });
                string originalAddress = Address(manualProject);
                using (var borrowed = new DevcelCliWatchProcess(manualProject))
                {
                    Until(() => borrowed.Connected, () => borrowed.Tick(Now()));
                    Check(Address(manualProject) == originalAddress, "Unity watch reuses existing manual server");
                }
                Thread.Sleep(7500);
                Check(!manual.HasExited && Address(manualProject) == originalAddress, "disposing Unity watch never shuts down manual server");
                using (var recovery = new DevcelCliWatchProcess(manualProject))
                {
                    Until(() => recovery.Connected, () => recovery.Tick(Now()));
                    manual.Kill();
                    manual.WaitForExit(3000);
                    Until(() => !recovery.Connected, () => recovery.Tick(Now()));
                    Until(() => recovery.Connected, () => recovery.Tick(Now()));
                    Check(Address(manualProject) != null, "Unity watcher acquires new managed server after prior authority crashes");
                }
                Thread.Sleep(7500);
                Check(Address(manualProject) == null, "replacement managed server stops after final watcher closes");
            }
            finally { if (!manual.HasExited) manual.Kill(); manual.WaitForExit(3000); }
        }

        Console.WriteLine("TOTAL " + checks);
    }
}
