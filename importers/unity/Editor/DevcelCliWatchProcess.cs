using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>
    /// Main-thread driven, non-blocking watch lifecycle. The CLI acquires/reuses the shared
    /// server; this owner only stops its own watch. Background callbacks only collect text.
    /// </summary>
    internal sealed class DevcelCliWatchProcess : IDisposable
    {
        [Serializable] private sealed class WatchEvent { public string @event; }
        [Serializable] private sealed class ErrorEnvelope { public ErrorBody error; }
        [Serializable] private sealed class ErrorBody { public string kind; public string text; public string code; public ErrorParams @params; }
        [Serializable] private sealed class ErrorParams { public string details; }

        private sealed class Child : IDisposable
        {
            private readonly object gate = new object();
            private readonly Queue<string> lines = new Queue<string>();
            private readonly StringBuilder stderr = new StringBuilder();
            private bool connectionFailed, outputClosed, errorClosed, disposed;
            private int queuedCharacters;
            public readonly Process Process;
            public readonly double StartedAt;
            private const int MaxDiagnosticCharacters = 8192;

            public Child(string arguments, double now)
            {
                StartedAt = now;
                Process = new Process { StartInfo = new ProcessStartInfo {
                    FileName = DevcelPaths.PrepareCliPath(), Arguments = arguments,
                    UseShellExecute = false, CreateNoWindow = true,
                    // EOF lets the CLI release its demand even if the Editor crashes.
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                }};
                Process.OutputDataReceived += (_, e) => {
                    lock (gate) {
                        if (disposed) return;
                        if (e.Data == null) { outputClosed = true; return; }
                        // Snapshot bursts only require one export; keep memory bounded.
                        if (lines.Count < 1024 && (lines.Count == 0 || queuedCharacters < 1024 * 1024))
                        { lines.Enqueue(e.Data); queuedCharacters += e.Data.Length; }
                    }
                };
                Process.ErrorDataReceived += (_, e) => {
                    lock (gate) {
                        if (disposed) return;
                        if (e.Data == null) { errorClosed = true; return; }
                        connectionFailed |= e.Data.Contains("Connection closed by server") ||
                            e.Data.Contains("Failed to read message") || e.Data.Contains("Connection appears to be dead");
                        // Preserve the most recent diagnostics without unlimited logging memory.
                        string line = e.Data.Length > MaxDiagnosticCharacters
                            ? e.Data.Substring(e.Data.Length - MaxDiagnosticCharacters) : e.Data;
                        stderr.AppendLine(line);
                        if (stderr.Length > MaxDiagnosticCharacters)
                            stderr.Remove(0, stderr.Length - MaxDiagnosticCharacters);
                    }
                };
                try { Process.Start(); Process.BeginOutputReadLine(); Process.BeginErrorReadLine(); }
                catch { Dispose(); throw; }
            }

            public bool HasExited => Process.HasExited;
            public string[] Drain() { lock (gate) { var result = lines.ToArray(); lines.Clear(); queuedCharacters = 0; return result; } }
            public bool ConnectionFailed { get { lock (gate) return connectionFailed; } }
            public bool OutputComplete { get { lock (gate) return outputClosed && errorClosed; } }
            public string Diagnostics { get { lock (gate) return stderr.ToString().Trim(); } }
            public void Dispose()
            {
                lock (gate) { if (disposed) return; disposed = true; lines.Clear(); stderr.Clear(); }
                try
                {
                    // Ask our watch to finish first. Never kill a process tree/shared server.
                    Process.StandardInput.Close();
                }
                catch (InvalidOperationException) { }
                catch (IOException) { }
                try { if (!Process.WaitForExit(250)) Process.Kill(); }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                try { Process.WaitForExit(250); }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                Process.Dispose();
            }
        }

        private readonly string watchArguments;
        private readonly string sourcePath;
        private Child watch;
        private double nextAttempt, connectedAt, exitedAt = -1;
        private int failures;
        private string lastReply, lastLoggedDiagnostic;
        private bool disposed;
        public bool Connected { get; private set; }
        public string LastError { get; private set; }
        public event Action Changed;
        private const double ConnectionTimeout = 15;
        private const double MaximumRetryDelay = 30;
        private const double StableConnectionPeriod = 30;

        public DevcelCliWatchProcess(string projectPath)
        {
            sourcePath = projectPath;
            watchArguments = "--project " + DevcelCliRunner.QuoteArgument(projectPath) +
                " watch --ensure-server --parent-stdin";
        }

        public void Tick(double now)
        {
            if (disposed) return;
            try
            {
                if (watch == null)
                {
                    if (now < nextAttempt) return;
                    // Do not gate acquisition on status: no existing server is a normal start.
                    watch = new Child(watchArguments, now);
                    exitedAt = -1;
                    lastReply = null;
                }

                bool exited = watch.HasExited;
                if (exited)
                {
                    Connected = false;
                    if (exitedAt < 0) exitedAt = now;
                    // Async readers may lag behind process exit. Never use an unbounded
                    // WaitForExit() on the Editor thread (including inherited-pipe failures).
                    if (!watch.OutputComplete && now - exitedAt < 1) return;
                }
                bool disconnected = false;
                foreach (var line in watch.Drain())
                {
                    WatchEvent message = null;
                    try { message = JsonUtility.FromJson<WatchEvent>(line); } catch { }
                    if (message == null || string.IsNullOrEmpty(message.@event))
                    {
                        // CLI failure envelopes carry typed errors; retain them for the Importer.
                        lastReply = line.Length > 8192 ? line.Substring(0, 8192) : line;
                        continue;
                    }
                    if (message.@event == "connected" && !Connected)
                    {
                        Connected = true;
                        connectedAt = now;
                        LastError = null;
                        // Catch up with edits made while the connection was unavailable.
                        Changed?.Invoke();
                    }
                    else if (message.@event == "snapshot" && Connected) Changed?.Invoke();
                    else if (message.@event == "disconnected") { disconnected = true; break; }
                }

                if (exited)
                {
                    Retry(now, "CLI watch exited (exit code " + watch.Process.ExitCode + ").");
                }
                else if (disconnected || watch.ConnectionFailed)
                    Retry(now, "The connection to the P2P server ended.");
                else if (!Connected && now - watch.StartedAt >= ConnectionTimeout)
                    Retry(now, "P2P server auto-start/connection did not complete within 15 seconds.");
                else if (Connected && now - connectedAt >= StableConnectionPeriod)
                { failures = 0; lastLoggedDiagnostic = null; }
            }
            catch (Exception ex)
            {
                Retry(now, "Cannot start or continue CLI monitoring: " + ex.Message);
            }
        }

        private void Retry(double now, string reason)
        {
            string stderr = watch?.Diagnostics;
            string details = string.IsNullOrWhiteSpace(lastReply) ? stderr : lastReply +
                (string.IsNullOrWhiteSpace(stderr) ? string.Empty : "\n" + stderr);
            string summary = SummarizeDiagnostic(lastReply, stderr);
            StopWatch();
            double delay = Math.Min(MaximumRetryDelay, Math.Pow(2, Math.Min(failures, 5)));
            failures = Math.Min(failures + 1, 6);
            nextAttempt = now + delay;
            LastError = ShortLine(reason) + (string.IsNullOrWhiteSpace(summary) ? string.Empty : " " + summary) +
                " " + delay + " seconds until retry.";
            string diagnostic = reason + (string.IsNullOrWhiteSpace(details) ? string.Empty : "\n" + details);
            if (diagnostic != lastLoggedDiagnostic)
            {
                lastLoggedDiagnostic = diagnostic;
                DevcelImporterSettings.LogWarning("Auto-import (" + sourcePath + "): " + diagnostic);
            }
        }

        private static string SummarizeDiagnostic(string reply, string stderr)
        {
            if (!string.IsNullOrWhiteSpace(reply))
            {
                try
                {
                    var error = JsonUtility.FromJson<ErrorEnvelope>(reply)?.error;
                    if (error?.kind == "text") return ShortLine(error.text);
                    if (error?.kind == "code") return ShortLine(error.@params?.details ?? error.code);
                    if (error?.kind == "input_validation") return "Source data validation failed. See the Console for details.";
                    if (error?.kind == "diagnostics") return "The source has issues. See the Console for details.";
                }
                catch { }
            }
            return !string.IsNullOrWhiteSpace(stderr) ? ShortLine(stderr) :
                (!string.IsNullOrWhiteSpace(reply) ? "See the Console for details." : null);
        }

        private static string ShortLine(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            string line = text.Trim().Split(new[] { '\r', '\n' }, 2)[0];
            return line.Length > 180 ? line.Substring(0, 180) + "… (details in Console)" : line;
        }

        private void StopWatch() { Connected = false; watch?.Dispose(); watch = null; lastReply = null; }
        public void Dispose() { if (disposed) return; disposed = true; StopWatch(); Changed = null; }
    }
}
