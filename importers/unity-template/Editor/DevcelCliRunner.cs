using System;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>The result of running the devcel CLI.</summary>
    public struct DevcelCliResult
    {
        public int ExitCode;
        public string Stdout;
        public string Stderr;

        /// <summary>Exit code 0 with ok:true in stdout.</summary>
        public bool Ok;

        /// <summary>A summary message on failure.</summary>
        public string Error;
    }

    /// <summary>
    /// Runs the devcel CLI as a subprocess. CLI stdout is always a single JSON object
    /// ({"ok":...}), and the exit code indicates success or failure.
    /// </summary>
    public static class DevcelCliRunner
    {
        /// <summary>For ProcessStartInfo.Arguments. Preserves spaces, quotes, and trailing backslashes.</summary>
        public static string QuoteArgument(string argument)
        {
            var escaped = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in argument ?? string.Empty)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { escaped.Append('\\', slashes * 2 + 1); escaped.Append(c); }
                else { escaped.Append('\\', slashes); escaped.Append(c); }
                slashes = 0;
            }
            escaped.Append('\\', slashes * 2);
            return escaped.Append('"').ToString();
        }

        /// <summary>Internally validates the bundled CLI's commands before saving. No CLI selection or external executable path is exposed.</summary>
        internal static bool ValidateBundledCli(out string error)
        {
            var help = Run("--help", timeoutMs: 5000, requireJson: false);
            if (!help.Ok || !(help.Stdout ?? string.Empty).Contains("Usage: devcel") ||
                !Regex.IsMatch(help.Stdout ?? string.Empty, @"(?m)^\s+pull(?:\s|$)"))
            {
                error = "Cannot verify the bundled CLI pull command. Reinstall the correct package for this OS/CPU.\n" + help.Error;
                return false;
            }
            var watchHelp = Run("watch --help", timeoutMs: 5000, requireJson: false);
            if (!watchHelp.Ok || !(watchHelp.Stdout ?? string.Empty).Contains("--ensure-server") ||
                !(watchHelp.Stdout ?? string.Empty).Contains("--parent-stdin"))
            {
                error = "Cannot verify the bundled CLI auto-import capability. Reinstall the correct package for this OS/CPU.\n" + watchHelp.Error;
                return false;
            }
            error = null;
            return true;
        }

        [Serializable]
        private class OkProbe
        {
            public bool ok;
        }

        /// <summary>
        /// Runs devcel.
        /// </summary>
        /// <param name="arguments">CLI arguments (the complete argument list, including --project and other options)</param>
        /// <param name="workingDir">Working directory (null for the default)</param>
        /// <param name="timeoutMs">Timeout in milliseconds</param>
        public static DevcelCliResult Run(
            string arguments,
            string workingDir = null,
            int timeoutMs = 120000,
            bool requireJson = true)
        {
            string cliPath = "";
            var result = new DevcelCliResult();

            try
            {
                cliPath = DevcelPaths.PrepareCliPath();
                var psi = new ProcessStartInfo
                {
                    FileName = cliPath,
                    Arguments = arguments,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                if (!string.IsNullOrEmpty(workingDir))
                    psi.WorkingDirectory = workingDir;

                using (var process = new Process { StartInfo = psi })
                {
                    var stdout = new StringBuilder();
                    var stderr = new StringBuilder();
                    process.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
                    process.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    if (!process.WaitForExit(timeoutMs))
                    {
                        try { process.Kill(); process.WaitForExit(1000); } catch { /* ignore */ }
                        result.ExitCode = -1;
                        result.Error = $"devcel CLI timed out ({timeoutMs}ms)";
                        return result;
                    }

                    // Ensure asynchronous reads are fully drained.
                    process.WaitForExit();

                    result.ExitCode = process.ExitCode;
                    result.Stdout = stdout.ToString().Trim();
                    result.Stderr = stderr.ToString().Trim();
                }
            }
            catch (Exception ex)
            {
                result.ExitCode = -1;
                result.Error =
                    $"Could not start devcel CLI (path='{cliPath}'): {ex.Message}\n" +
                    "Reinstall the package containing the bundled CLI for this OS/CPU.";
                return result;
            }

            // Export/status require the JSON success envelope. Help/version probing opts out explicitly.
            bool ok = result.ExitCode == 0;
            string error = null;
            if (requireJson)
            {
                try
                {
                    var probe = JsonUtility.FromJson<OkProbe>(result.Stdout);
                    ok = ok && probe != null && probe.ok;
                    if (probe != null && !probe.ok) error = result.Stdout; // Preserve the complete typed AppError, including parameters and reports.
                }
                catch { ok = false; }
                if (!ok && string.IsNullOrEmpty(error)) error = "The CLI did not return valid ok:true JSON.";
            }
            result.Ok = ok;
            if (!ok && string.IsNullOrEmpty(result.Error))
                result.Error = error ?? (string.IsNullOrEmpty(result.Stderr) ? result.Stdout : result.Stderr);
            return result;
        }
    }
}
