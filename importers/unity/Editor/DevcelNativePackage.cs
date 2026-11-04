using System;
using System.IO;
using System.Security.Cryptography;
using UnityEditor;
using UnityEditor.PackageManager;
using PackageInfo = UnityEditor.PackageManager.PackageInfo;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>Installs only a matching distribution as a project-local UPM dependency.</summary>
    internal static class DevcelNativePackage
    {
        internal const string Name = "org.devcel.native";
        [Serializable] private sealed class Requirements { public int schema_version; public string source_fingerprint; }
        [Serializable] private sealed class Manifest {
            public int schema_version; public string source_fingerprint;
            public NativeBinary native_runtime;
            public NativeBinary[] player_runtimes;
        }
        [Serializable] private sealed class NativeBinary { public string path, sha256; }
        internal static PackageInfo Installed => Array.Find(PackageInfo.GetAllRegisteredPackages(), item => item.name == Name);
        internal static string Root => Installed?.resolvedPath;

        internal static void Validate(string root, bool requireCli = true)
        {
            string requiredFile = Path.Combine(DevcelPaths.PackageRoot, "Editor/NativeRequirements.json");
            var required = JsonUtility.FromJson<Requirements>(File.ReadAllText(requiredFile));
            SafePath(root, Path.Combine(root, "Tools~/manifest.json"));
            var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(Path.Combine(root, "Tools~/manifest.json")));
            if (required == null || required.schema_version != 1 || string.IsNullOrEmpty(required.source_fingerprint) ||
                manifest == null || manifest.schema_version != 1 ||
                manifest.source_fingerprint != required.source_fingerprint)
                throw new IOException("Native tools do not match this SDK source revision. Install the corresponding Devcel Unity distribution.");
            if (manifest.native_runtime == null || string.IsNullOrEmpty(manifest.native_runtime.path))
                throw new IOException("The matching native runtime manifest is missing.");
            string expected = Application.platform == RuntimePlatform.WindowsEditor ? "Plugins/Windows/x86_64/devcel_runtime.dll" :
                Application.platform == RuntimePlatform.OSXEditor ? "Plugins/macOS/libdevcel_runtime.dylib" : "Plugins/Linux/x86_64/libdevcel_runtime.so";
            if (manifest.native_runtime.path != expected) throw new IOException("Native runtime does not match this Editor platform.");
            string native = Path.GetFullPath(Path.Combine(root, manifest.native_runtime.path));
            SafePath(root, native);
            using (var input = File.OpenRead(native))
            using (var sha = SHA256.Create())
                if (!string.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), manifest.native_runtime.sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Native runtime checksum mismatch.");
            BuildTarget target = Application.platform == RuntimePlatform.WindowsEditor ? BuildTarget.StandaloneWindows64 :
                Application.platform == RuntimePlatform.OSXEditor ? BuildTarget.StandaloneOSX : BuildTarget.StandaloneLinux64;
            if (!DevcelNativeBinary.Validate(native, target, out string binaryError)) throw new IOException(binaryError);
            if (requireCli) DevcelPaths.ValidateCliPayload(root);
        }

        private static void SafePath(string root, string path)
        {
            string relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
            if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar))
                throw new IOException("Native payload path escapes its package.");
            string current = root;
            foreach (string part in ("." + Path.DirectorySeparatorChar + relative).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) {
                current = Path.Combine(current, part);
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked native payload paths are unsupported.");
            }
        }

        internal static void ValidatePlayer(string root, string relative)
        {
            SafePath(root, Path.Combine(root, "Tools~/manifest.json"));
            var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(Path.Combine(root, "Tools~/manifest.json")));
            if (manifest == null || manifest.schema_version != 1)
                throw new IOException("The native runtime manifest is invalid.");
            NativeBinary entry = null;
            foreach (var item in manifest.player_runtimes ?? Array.Empty<NativeBinary>())
                if (item != null && item.path == relative)
                {
                    if (entry != null) throw new IOException("Duplicate mobile runtime manifest entry.");
                    entry = item;
                }
            if (entry == null) throw new IOException("Mobile runtime is missing from this distribution. Install the complete release UPM tarball: " + relative);
            string path = Path.Combine(root, relative);
            SafePath(root, path);
            using (var input = File.OpenRead(path))
            using (var sha = SHA256.Create())
                if (!string.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), entry.sha256, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Mobile runtime checksum mismatch: " + relative);
        }

        [MenuItem("Devcel/Install Matching Native Tools", priority = 3)]
        private static void ChooseDistribution()
        {
            string source = EditorUtility.OpenFolderPanel("Select devcel-unity from the matching distribution ZIP", "", "");
            if (string.IsNullOrEmpty(source)) return;
            try { Install(source); }
            catch (Exception error) { EditorUtility.DisplayDialog("Native tools were not installed", error.Message, "Close"); }
        }

        internal static void Install(string source)
        {
            Validate(source); // No execution and no project mutations before validation.
            string destination = Path.Combine(DevcelPaths.ProjectRoot, "Packages", Name);
            if (Directory.Exists(destination) || Installed != null)
                throw new IOException("A native package is already installed. Remove it through Package Manager before installing a different matching distribution. Existing files were not overwritten.");
            string stage = Path.Combine(DevcelPaths.ProjectRoot, "Library", "Devcel", "NativeStaging", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage);
            try {
                foreach (string directory in new[] { "Tools~", "Plugins", "ThirdPartyNotices" }) CopyTree(source, directory, stage);
                SafePath(source, Path.Combine(source, "LICENSE"));
                File.Copy(Path.Combine(source, "LICENSE"), Path.Combine(stage, "LICENSE"));
                File.WriteAllText(Path.Combine(stage, "package.json"), "{\"name\":\"" + Name + "\",\"version\":\"" + DevcelPaths.PackageVersion + "\",\"displayName\":\"Devcel Native Tools\",\"description\":\"Verified native dependency for the matching Devcel SDK\",\"unity\":\"2021.3\"}\n");
                Validate(stage);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                Directory.Move(stage, destination); // Atomic directory publication; never writes PackageCache.
                Client.Resolve();
                AssetDatabase.Refresh();
            } finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
        }

        private static void CopyTree(string source, string relative, string stage)
        {
            string input = Path.Combine(source, relative);
            SafePath(source, input);
            Directory.CreateDirectory(Path.Combine(stage, relative));
            foreach (string file in Directory.GetFiles(input)) {
                SafePath(source, file);
                File.Copy(file, Path.Combine(stage, relative, Path.GetFileName(file)));
            }
            foreach (string child in Directory.GetDirectories(input)) CopyTree(source, Path.Combine(relative, Path.GetFileName(child)), stage);
        }
    }
}
