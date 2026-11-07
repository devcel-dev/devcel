using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace Devcel.Unity.Editor
{
    /// <summary>Downloads the immutable native distribution matching this Git-installed SDK.</summary>
    internal static class DevcelNativeDownload
    {
        [Serializable] private sealed class Bootstrap
        {
            public int schema_version;
            public string version, source_commit, source_repository, archive_sha256;
        }

        private static UnityWebRequest request;
        private static string download;
        private static Bootstrap bootstrap;

        static DevcelNativeDownload() { AssemblyReloadEvents.beforeAssemblyReload += Cleanup; }

        [MenuItem("Devcel/Download Matching Native Tools", priority = 3)]
        internal static void Start()
        {
            try
            {
                if (request != null) throw new IOException("A native download is already running.");
                if (DevcelNativePackage.Installed != null) throw new IOException("Native tools are already installed. Remove them before installing another version.");
                string path = Path.Combine(DevcelPaths.PackageRoot, "Editor/NativeBootstrap.json");
                bootstrap = JsonUtility.FromJson<Bootstrap>(File.ReadAllText(path));
                if (bootstrap == null || bootstrap.schema_version != 1 || bootstrap.version != DevcelPaths.PackageVersion ||
                    !Regex.IsMatch(bootstrap.source_repository ?? "", @"\A[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\z") ||
                    !Regex.IsMatch(bootstrap.source_commit ?? "", @"\A[0-9a-f]{40}\z") ||
                    !Regex.IsMatch(bootstrap.archive_sha256 ?? "", @"\A[0-9a-f]{64}\z"))
                    throw new IOException("Invalid native download manifest. Reinstall the Git package.");
                string directory = Path.Combine(DevcelPaths.ProjectRoot, "Library", "Devcel", "Downloads");
                Directory.CreateDirectory(directory);
                download = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".zip");
                string url = "https://github.com/" + bootstrap.source_repository + "/releases/download/v" + bootstrap.version +
                    "/org.devcel.unity-" + bootstrap.version + "-git.zip";
                request = UnityWebRequest.Get(url);
                request.downloadHandler = new DownloadHandlerFile(download);
                request.SendWebRequest();
                EditorApplication.update += Poll;
            }
            catch (Exception ex) { Cleanup(); EditorUtility.DisplayDialog("Native tools were not installed", ex.Message, "Close"); }
        }

        [MenuItem("Devcel/Download Matching Native Tools", true)]
        private static bool CanStart()
        {
            return request == null && DevcelNativePackage.Installed == null &&
                File.Exists(Path.Combine(DevcelPaths.PackageRoot, "Editor/NativeBootstrap.json"));
        }

        private static void Poll()
        {
            if (request == null) return;
            if (!request.isDone)
            {
                if (EditorUtility.DisplayCancelableProgressBar("Devcel", "Downloading matching native tools", request.downloadProgress))
                { request.Abort(); Cleanup(); }
                return;
            }
            try
            {
                if (request.result != UnityWebRequest.Result.Success) throw new IOException("Download failed: " + request.error);
                InstallArchive(download, bootstrap.archive_sha256);
                EditorUtility.DisplayDialog("Devcel", "Matching native tools installed.", "Close");
            }
            catch (Exception ex) { EditorUtility.DisplayDialog("Native tools were not installed", ex.Message, "Close"); }
            finally { Cleanup(); }
        }

        internal static void InstallArchive(string archivePath, string expectedHash)
        {
            using (var input = File.OpenRead(archivePath))
            using (var sha = SHA256.Create())
                if (!string.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Downloaded native distribution checksum does not match this SDK.");
            string stage = Path.Combine(DevcelPaths.ProjectRoot, "Library", "Devcel", "NativeDownload", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage);
            try { Extract(archivePath, stage); DevcelNativePackage.Install(stage); }
            finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
        }

        internal static void Extract(string archivePath, string destination)
        {
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            using (var archive = ZipFile.OpenRead(archivePath))
                foreach (var entry in archive.Entries)
                {
                    string name = entry.FullName;
                    if (!(name == "LICENSE" || name.StartsWith("Tools~/", StringComparison.Ordinal) ||
                          name.StartsWith("Plugins/", StringComparison.Ordinal) || name.StartsWith("ThirdPartyNotices/", StringComparison.Ordinal))) continue;
                    if (name.EndsWith("/", StringComparison.Ordinal)) continue;
                    string[] parts = name.Split('/');
                    if (Array.Exists(parts, p => p == "" || p == "." || p == ".." || p.Contains(":") || p.Contains("\\")) ||
                        !seen.Add(name) || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000 ||
                        entry.Length >= 100L * 1024 * 1024 || (total += entry.Length) > 1024L * 1024 * 1024)
                        throw new IOException("Unsafe or oversized native archive entry: " + name);
                    string output = Path.Combine(destination, name.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(output));
                    using (var input = entry.Open())
                    using (var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(file);
                }
        }

        private static void Cleanup()
        {
            EditorApplication.update -= Poll;
            EditorUtility.ClearProgressBar();
            if (request != null) { request.Dispose(); request = null; }
            if (!string.IsNullOrEmpty(download) && File.Exists(download)) File.Delete(download);
            download = null;
            bootstrap = null;
        }
    }
}
