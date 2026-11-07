using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Path resolution utilities.</summary>
    public static class DevcelPaths
    {
        /// <summary>Absolute path to the Unity project root (the parent directory of Assets).</summary>
        public static string ProjectRoot =>
            Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;

        /// <summary>Resolves a project-root-relative path to an absolute path (may be outside Assets).</summary>
        public static string ResolveFromProjectRoot(string relativeOrAbsolute)
        {
            if (string.IsNullOrEmpty(relativeOrAbsolute)) return string.Empty;
            relativeOrAbsolute = NormalizeSeparators(relativeOrAbsolute);
            if (Path.IsPathRooted(relativeOrAbsolute)) return Path.GetFullPath(relativeOrAbsolute);
            return Path.GetFullPath(Path.Combine(ProjectRoot, relativeOrAbsolute));
        }

        private static string NormalizeSeparators(string path)
        {
            // Never reinterpret a Windows absolute path as a relative Linux/macOS filename.
            if (Path.DirectorySeparatorChar != '\\' &&
                (path.Contains(":") || path.StartsWith("\\\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal)))
                throw new ArgumentException("Absolute paths from another OS cannot be used. Reselect the source project/output location on this computer.");
            return path.Replace('\\', '/');
        }

        /// <summary>Saves shared settings relative to the Unity project root. Does not fall back to another drive.</summary>
        public static string ToProjectRelative(string path)
        {
            if (string.IsNullOrEmpty(path)) return string.Empty;
            path = NormalizeSeparators(path);
            if (Path.IsPathRooted(path) && !Path.IsPathFullyQualified(path))
                throw new ArgumentException("Paths without a drive cannot be used. Specify a fully qualified path or a project-relative path.");
            if (Path.DirectorySeparatorChar == '\\' && path.Contains(":") && !Path.IsPathFullyQualified(path))
                throw new ArgumentException("Drive-relative paths cannot be used. Specify a fully qualified path.");
            string relative = Path.GetRelativePath(ProjectRoot, ResolveFromProjectRoot(path));
            if (Path.IsPathRooted(relative) || relative.Contains(":"))
                throw new ArgumentException("Keep shared settings on the same drive/share. Absolute paths to other drives will not be saved.");
            return relative.Replace('\\', '/');
        }

        /// <summary>
        /// Returns the absolute path to this extension package's root.
        /// Resolves both UPM installations (Packages/org.devcel.unity) and installations under Assets.
        /// </summary>
        public static string PackageRoot
        {
            get
            {
                // First use the official UPM API (reliable for installations under Packages/).
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(
                    typeof(DevcelPaths).Assembly);
                if (info != null && !string.IsNullOrEmpty(info.resolvedPath))
                    return info.resolvedPath;

                // Fallback for installation directly under Assets: resolve from this script's asset path.
                var guids = AssetDatabase.FindAssets("t:Script DevcelPaths");
                foreach (var guid in guids)
                {
                    var assetPath = AssetDatabase.GUIDToAssetPath(guid);
                    if (assetPath.EndsWith("Editor/DevcelPaths.cs"))
                    {
                        var editorDir = Path.GetDirectoryName(assetPath);          // .../Editor
                        var pkgDir = Path.GetDirectoryName(editorDir);             // .../(package root)
                        return Path.GetFullPath(ToAbsolute(pkgDir));
                    }
                }
                return string.Empty;
            }
        }

        internal static string DistributionRoot => File.Exists(Path.Combine(PackageRoot, "Tools~/manifest.json")) ? PackageRoot : DevcelNativePackage.Root ?? PackageRoot;
        internal static string NativeAssetRoot => DistributionRoot == PackageRoot ? PackageAssetRoot : "Packages/" + DevcelNativePackage.Name;

        /// <summary>The virtual asset path used by PluginImporter (distinct from the physical UPM cache path).</summary>
        internal static string PackageAssetRoot
        {
            get
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(DevcelPaths).Assembly);
                if (info != null && !string.IsNullOrEmpty(info.name)) return "Packages/" + info.name;
                foreach (string guid in AssetDatabase.FindAssets("t:Script DevcelPaths"))
                {
                    string path = AssetDatabase.GUIDToAssetPath(guid).Replace('\\', '/');
                    const string suffix = "/Editor/DevcelPaths.cs";
                    if (path.EndsWith(suffix, System.StringComparison.Ordinal))
                        return path.Substring(0, path.Length - suffix.Length);
                }
                return string.Empty;
            }
        }

        /// <summary>Converts a relative asset path ("Assets/..." or "Packages/...") to an absolute path.</summary>
        public static string ToAbsolute(string assetOrPackagePath)
        {
            // Assets is relative to ProjectRoot. Packages also resolves to a physical path relative to ProjectRoot.
            return ResolveFromProjectRoot(assetOrPackagePath);
        }

        /// <summary>Product version for the generated native-tools UPM package metadata.</summary>
        public static string PackageVersion => ReadPackageVersion(PackageRoot);

        [DataContract]
        private sealed class PackageManifest
        {
            [DataMember(IsRequired = true)] public string name;
            [DataMember(IsRequired = true)] public string version;
        }

        private static string ReadPackageVersion(string packageRoot)
        {
            if (string.IsNullOrEmpty(packageRoot))
                throw new IOException("Cannot locate the bundled CLI package. Reinstall the correct package for this OS/CPU.");
            string root = Path.GetFullPath(packageRoot);
            string packagePath = Path.Combine(root, "package.json");
            ValidateBundledPath(root, packagePath);
            PackageManifest package;
            try
            {
                using (var stream = File.OpenRead(packagePath))
                    package = (PackageManifest)new DataContractJsonSerializer(typeof(PackageManifest)).ReadObject(stream);
            }
            catch (Exception ex)
            {
                throw new IOException("The Devcel package.json is missing or invalid. Reinstall the matching package.", ex);
            }
            // Match the stable/prerelease syntax accepted by the release-version transaction.
            if (package == null || package.name != "org.devcel.unity" || package.version == null ||
                !Regex.IsMatch(package.version, @"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?\z"))
                throw new IOException("The Devcel package.json has an invalid name/version. Reinstall the matching package.");
            return package.version;
        }

        /// <summary>The editor process architecture selects the bundled CLI, including Rosetta.</summary>
        public static string CliPlatform
        {
            get
            {
                string architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant();
                string arch = architecture == "x64" ? "x64" : architecture == "arm64" ? "arm64" : "unsupported";
#if UNITY_EDITOR_WIN
                return "win-" + arch;
#elif UNITY_EDITOR_OSX
                return "osx-" + arch;
#else
                return "linux-" + arch;
#endif
            }
        }

        /// <summary>Resolves only the packaged CLI matching the current Editor OS/CPU.</summary>
        public static string ResolveCliPath()
        {
            string root = DistributionRoot;
            if (string.IsNullOrEmpty(root))
                throw new IOException("Cannot locate the bundled CLI package. Reinstall the correct package for this OS/CPU.");
            return Path.GetFullPath(Path.Combine(root, "Tools~", CliPlatform,
#if UNITY_EDITOR_WIN
                "devcel.exe"
#else
                "devcel"
#endif
            ));
        }

        [DataContract]
        private sealed class CliManifest
        {
            [DataMember(IsRequired = true)] public int schema_version;
            [DataMember(IsRequired = true)] public string[] supportedPlatforms;
            [DataMember(IsRequired = true)] public Dictionary<string, CliBinary> binaries;
        }

        [DataContract]
        private sealed class CliBinary
        {
            [DataMember(IsRequired = true)] public string path;
            [DataMember(IsRequired = true)] public string sha256;
        }

        /// <summary>
        /// Validates the bundled CLI manifest/hash immediately before starting or restarting watch, and restores only executable permissions lost during ZIP extraction.
        /// External CLI paths and commands on PATH are not accepted.
        /// </summary>
        public static string PrepareCliPath()
        {
            string root = Path.GetFullPath(DistributionRoot);
            if (!File.Exists(Path.Combine(root, "Tools~/manifest.json")))
                throw new IOException("Matching Devcel native tools are missing. Choose Devcel > Download Matching Native Tools, or install the matching release archive offline.");
            if (root != Path.GetFullPath(PackageRoot)) DevcelNativePackage.Validate(root);
            string executable = ValidateCliPayload(root);
#if !UNITY_EDITOR_WIN
            if (RunPermissionTool("/bin/test", "-x " + DevcelCliRunner.QuoteArgument(executable)) != 0) {
                ValidateBundledPath(root, executable);
                if (RunPermissionTool("/bin/chmod", "u+x " + DevcelCliRunner.QuoteArgument(executable)) != 0 ||
                    RunPermissionTool("/bin/test", "-x " + DevcelCliRunner.QuoteArgument(executable)) != 0)
                    throw new IOException("Cannot restore executable permissions on the verified bundled CLI.");
            }
#endif
            return ValidateCliPayload(root);
        }

        internal static string ValidateCliPayload(string root)
        {
            string executable = Path.Combine(root, "Tools~", CliPlatform, Application.platform == RuntimePlatform.WindowsEditor ? "devcel.exe" : "devcel");
            string tools = Path.Combine(root, "Tools~");
            string manifestPath = Path.Combine(tools, "manifest.json");
            ValidateBundledPath(root, manifestPath);
            CliManifest manifest;
            try
            {
                using (var stream = File.OpenRead(manifestPath))
                    manifest = (CliManifest)new DataContractJsonSerializer(typeof(CliManifest),
                        new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true }).ReadObject(stream);
            }
            catch (Exception ex)
            {
                throw new IOException("Native tools are missing or invalid. Use Devcel > Install Matching Native Tools with the matching distribution.", ex);
            }
            string platform = CliPlatform;
            if (manifest == null || manifest.schema_version != 1 ||
                manifest.supportedPlatforms == null || Array.IndexOf(manifest.supportedPlatforms, platform) < 0 ||
                manifest.binaries == null || !manifest.binaries.TryGetValue(platform, out CliBinary binary) || binary == null)
                throw new IOException("The bundled CLI manifest does not match the OS/CPU: " + platform + ". Reinstall the correct package for this OS/CPU.");
            string expectedPath = platform + "/" + Path.GetFileName(executable);
            if (!string.Equals(binary.path, expectedPath, StringComparison.Ordinal) || !IsSha256(binary.sha256))
                throw new IOException("The bundled CLI manifest contains an invalid path/SHA256. Reinstall the matching package.");
            ValidateBundledPath(root, executable);
            VerifyCliHash(executable, binary.sha256);
            return executable;
        }

        private static bool IsSha256(string value)
        {
            if (value == null || value.Length != 64) return false;
            foreach (char c in value)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
            return true;
        }

        private static void VerifyCliHash(string executable, string expected)
        {
            using (var stream = File.OpenRead(executable))
            using (var sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
                if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("The bundled CLI SHA256 does not match the manifest. Execution and permission changes have been canceled. Reinstall the matching package.");
            }
        }

        private static void ValidateBundledPath(string root, string path)
        {
            string relative = Path.GetRelativePath(root, Path.GetFullPath(path));
            if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new IOException("The bundled CLI path points outside the package. Reinstall the correct package.");
            string current = root;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Symbolic links cannot be used for the bundled CLI package. Reinstall the correct package.");
            foreach (string part in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            {
                current = Path.Combine(current, part);
                if (!File.Exists(current) && !Directory.Exists(current))
                    throw new IOException("Bundled CLI files are missing: " + current + ". Reinstall the matching package.");
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Symbolic links cannot be used in the bundled CLI path: " + current + ". Reinstall the correct package.");
            }
        }

#if !UNITY_EDITOR_WIN
        private static int RunPermissionTool(string tool, string arguments)
        {
            using (var process = new Process { StartInfo = new ProcessStartInfo {
                FileName = tool, Arguments = arguments, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            } })
            {
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(5000))
                {
                    try { process.Kill(); process.WaitForExit(1000); } catch { /* Preserve the timeout diagnostic. */ }
                    throw new IOException("Checking/restoring bundled CLI executable permissions timed out.");
                }
                process.WaitForExit();
                return process.ExitCode;
            }
        }
#endif

    }
}
