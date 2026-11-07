using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>Optional, editor-only bridge to the separately installed MasterMemory dependencies.</summary>
    [InitializeOnLoad]
    internal static class DevcelMasterMemory
    {
        private const string PendingBundle = "Devcel.MasterMemory.PendingBundle";
        private const string PendingScript = "Devcel.MasterMemory.PendingScript";
        private const string PendingScriptHash = "Devcel.MasterMemory.PendingScriptHash";
        private static string Key(string key) => "Devcel.MasterMemory." + DevcelPaths.ProjectRoot + "." + key;
        internal static bool Enabled { get => EditorPrefs.GetBool(Key("Enabled"), false); set { if (Enabled != value) EditorPrefs.SetBool(Key("Enabled"), value); } }
        internal static string Source { get => EditorPrefs.GetString(Key("Source"), ""); set { value = value ?? ""; if (Source != value) EditorPrefs.SetString(Key("Source"), value); } }
        internal static string Python { get => EditorPrefs.GetString(Key("Python"), Application.platform == RuntimePlatform.WindowsEditor ? "python" : "python3"); set { value = value ?? ""; if (Python != value) EditorPrefs.SetString(Key("Python"), value); } }

        static DevcelMasterMemory() { EditorApplication.delayCall += FinishPending; }

        private static string Hash(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        // The integration only owns files it previously created and whose bytes have not changed.
        private static void CheckOwned(string path, string kind)
        {
            if (!File.Exists(path)) return;
            string expected = EditorPrefs.GetString(Key(kind + ":" + path), "");
            if (string.IsNullOrEmpty(expected) || Hash(path) != expected)
                throw new IOException("MasterMemory refuses to overwrite an unowned or modified " + kind + ": " + path);
        }
        private static void MarkOwned(string path, string kind) => EditorPrefs.SetString(Key(kind + ":" + path), Hash(path));

        private static string UnderAssets(string path)
        {
            string full = Path.GetFullPath(path);
            string assets = Path.GetFullPath(Application.dataPath);
            string relative = Path.GetRelativePath(assets, full);
            if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(relative))
                throw new IOException("MasterMemory output must be under Assets.");
            string current = assets;
            foreach (string part in relative.Split(Path.DirectorySeparatorChar))
            {
                current = Path.Combine(current, part);
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("MasterMemory output must not traverse a symlink: " + current);
            }
            return full;
        }

        internal static void NotifyExport(DevcelProjectConfig project, string bundle)
        {
            if (!Enabled || project == null || project.projectName != Source) return;
            // ExportAll may still be inside StartAssetEditing. Defer until it finishes.
            EditorApplication.delayCall += () =>
            {
                if (!Enabled || project.projectName != Source) return;
                try { Generate(project, bundle); }
                catch (Exception ex) { DevcelImporterSettings.LogError("MasterMemory: " + ex.Message); }
            };
        }

        internal static void Generate(DevcelProjectConfig project, string bundle)
        {
            if (project == null || project.minimal) throw new InvalidOperationException("MasterMemory requires a full export.");
            if (EditorApplication.isPlaying) throw new InvalidOperationException("Exit Play mode before rebuilding the MasterMemory asset.");
            string generator = Path.Combine(DevcelPaths.PackageRoot, "Tools~", "MasterMemory", "generate.py");
            if (!File.Exists(generator)) throw new FileNotFoundException("The installed Devcel package does not contain the MasterMemory generator.", generator);
            string script = UnderAssets(Path.Combine(DevcelPaths.ToAbsolute(project.GetCodeOutputFolder()), "DevcelMasterMemory.cs"));
            string bytes = UnderAssets(Path.ChangeExtension(bundle, ".mastermemory.bytes"));
            CheckOwned(script, "script"); CheckOwned(bytes, "binary");
            string before = File.Exists(script) ? Hash(script) : null;
            Directory.CreateDirectory(Path.GetDirectoryName(script));
            RunGenerator(generator, bundle, script);
            MarkOwned(script, "script");
            string after = Hash(script);
            SessionState.SetString(PendingBundle, bundle);
            SessionState.SetString(PendingScript, script);
            SessionState.SetString(PendingScriptHash, after);
            AssetDatabase.Refresh();
            // Changed source must wait for a successful domain reload. The static
            // initializer resumes the job after compilation; never use a stale builder.
            if (before == after) EditorApplication.delayCall += FinishPending;
        }

        private static void RunGenerator(string generator, string bundle, string output)
        {
            var start = new ProcessStartInfo {
                FileName = Python,
                Arguments = DevcelCliRunner.QuoteArgument(generator) + " " + DevcelCliRunner.QuoteArgument(bundle) + " " + DevcelCliRunner.QuoteArgument(output),
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            };
            using (var process = Process.Start(start))
            {
                if (process == null) throw new IOException("Could not start Python.");
                var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(120000)) { process.Kill(); throw new IOException("MasterMemory generator timed out."); }
                System.Threading.Tasks.Task.WaitAll(stdout, stderr);
                if (process.ExitCode != 0) throw new IOException("MasterMemory generator failed: " + stderr.Result);
            }
        }

        private static byte[] BuildBinary(string bundle)
        {
            Type builder = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("DevcelMasterMemory.BuildData", false)).FirstOrDefault(t => t != null);
            var method = builder?.GetMethod("FromJson", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
            if (method == null || method.ReturnType != typeof(byte[]))
                throw new InvalidOperationException("Generated MasterMemory builder is unavailable. Install MasterMemory, MessagePack and Newtonsoft.Json, and check compilation errors.");
            return (byte[])method.Invoke(null, new object[] { File.ReadAllText(bundle) });
        }

        // A teammate can adopt checked-in output only if it exactly matches a fresh
        // generation. This never modifies either existing file.
        internal static void Adopt(DevcelProjectConfig project, string bundle)
        {
            if (project == null || project.minimal) throw new InvalidOperationException("MasterMemory requires a full export.");
            string generator = Path.Combine(DevcelPaths.PackageRoot, "Tools~", "MasterMemory", "generate.py");
            string script = UnderAssets(Path.Combine(DevcelPaths.ToAbsolute(project.GetCodeOutputFolder()), "DevcelMasterMemory.cs"));
            string bytes = UnderAssets(Path.ChangeExtension(bundle, ".mastermemory.bytes"));
            if (!File.Exists(script)) throw new FileNotFoundException("No generated script to adopt.", script);
            string temporary = Path.GetTempFileName();
            try
            {
                RunGenerator(generator, bundle, temporary);
                if (Hash(script) != Hash(temporary)) throw new IOException("Existing script does not match the current generator and schema.");
                if (File.Exists(bytes))
                {
                    byte[] expected = BuildBinary(bundle);
                    byte[] actual = File.ReadAllBytes(bytes);
                    if (!expected.SequenceEqual(actual)) throw new IOException("Existing binary does not match the current bundle.");
                }
                MarkOwned(script, "script");
                if (File.Exists(bytes)) MarkOwned(bytes, "binary");
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static void FinishPending()
        {
            string bundle = SessionState.GetString(PendingBundle, "");
            if (string.IsNullOrEmpty(bundle)) return;
            if (!Enabled) { SessionState.EraseString(PendingBundle); SessionState.EraseString(PendingScript); SessionState.EraseString(PendingScriptHash); return; }
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) { EditorApplication.delayCall += FinishPending; return; }
            string script = SessionState.GetString(PendingScript, "");
            string expected = SessionState.GetString(PendingScriptHash, "");
            try
            {
                if (EditorApplication.isPlaying) throw new InvalidOperationException("Exit Play mode and reimport before rebuilding the MasterMemory asset.");
                if (!File.Exists(script) || Hash(script) != expected) throw new IOException("Generated schema changed during compilation.");
                var binary = BuildBinary(bundle);
                string destination = UnderAssets(Path.ChangeExtension(bundle, ".mastermemory.bytes"));
                CheckOwned(destination, "binary");
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllBytes(temporary, binary);
                    CheckOwned(destination, "binary");
                    if (File.Exists(destination)) File.Replace(temporary, destination, null);
                    else File.Move(temporary, destination);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
                MarkOwned(destination, "binary");
                AssetDatabase.Refresh();
                DevcelImporterSettings.Log("MasterMemory asset updated: " + DevcelPaths.ToProjectRelative(destination));
            }
            catch (Exception ex)
            {
                var cause = ex is TargetInvocationException invocation && invocation.InnerException != null ? invocation.InnerException : ex;
                DevcelImporterSettings.LogError("MasterMemory asset not updated: " + cause.Message);
            }
            finally
            {
                SessionState.EraseString(PendingBundle); SessionState.EraseString(PendingScript); SessionState.EraseString(PendingScriptHash);
            }
        }
    }

    internal sealed class DevcelMasterMemoryWindow : EditorWindow
    {
        [MenuItem("Devcel/MasterMemory (Experimental)")]
        private static void Open() => GetWindow<DevcelMasterMemoryWindow>("Devcel MasterMemory");
        private void OnGUI()
        {
            EditorGUILayout.HelpBox("Optional MasterMemory output. Install MasterMemory, MessagePack and Newtonsoft.Json separately. One source per assembly; full export required. Python 3 is required on the Editor machine.", MessageType.Info);
            DevcelMasterMemory.Source = EditorGUILayout.TextField("Source ID", DevcelMasterMemory.Source);
            DevcelMasterMemory.Python = EditorGUILayout.TextField("Python executable", DevcelMasterMemory.Python);
            DevcelMasterMemory.Enabled = EditorGUILayout.Toggle("Build after import", DevcelMasterMemory.Enabled);
            if (GUILayout.Button("Adopt matching existing outputs"))
            {
                try
                {
                    var settings = DevcelImporterSettings.Instance;
                    var project = settings.projects.Find(p => p != null && p.projectName == DevcelMasterMemory.Source);
                    if (project == null) throw new InvalidOperationException("Source ID not found.");
                    string bundle = Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName);
                    DevcelMasterMemory.Adopt(project, bundle);
                    DevcelImporterSettings.Log("MasterMemory matching outputs adopted on this machine.");
                }
                catch (Exception ex) { DevcelImporterSettings.LogError("MasterMemory: " + ex.Message); }
            }
            if (GUILayout.Button("Import selected source now"))
            {
                var settings = DevcelImporterSettings.Instance;
                var project = settings.projects.Find(p => p != null && p.projectName == DevcelMasterMemory.Source);
                if (project == null) DevcelImporterSettings.LogError("MasterMemory: source ID not found.");
                else if (!DevcelMasterMemory.Enabled) DevcelImporterSettings.LogError("MasterMemory: enable Build after import first.");
                else DevcelExporter.ExportProject(project, settings);
            }
        }
    }
}
