#if UNITY_IOS
using System;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    internal static class DevcelIosLinker
    {
        [Serializable] private sealed class Requirements { public string[] link_flags; public Simulator simulator; }
        [Serializable] private sealed class Simulator { public string[] link_flags; }

        [PostProcessBuild(100)]
        private static void Configure(BuildTarget target, string output)
        {
            if (target != BuildTarget.iOS) return;
            string root = DevcelPaths.DistributionRoot;
            bool simulator = PlayerSettings.iOS.sdkVersion == iOSSdkVersion.SimulatorSDK;
            string relative = simulator ? "Plugins/iOSSimulator/libdevcel_runtime.a" : "Plugins/iOS/libdevcel_runtime.a";
            string archive = Path.Combine(root, relative);
            if (!File.Exists(archive)) return;
            DevcelNativePackage.ValidatePlayer(root, relative);
            if (!DevcelNativeBinary.Validate(archive, BuildTarget.iOS, out string error)) throw new InvalidOperationException(error);
            var requirements = JsonUtility.FromJson<Requirements>(File.ReadAllText(Path.Combine(root, "Tools~/Mobile/ios.json")));
            string[] flags = simulator ? requirements?.simulator?.link_flags : requirements?.link_flags;
            if (flags == null || flags.Length == 0)
                throw new InvalidOperationException("Devcel iOS link requirements are missing. Reinstall the complete UPM tarball.");
            for (int i = 0; i < flags.Length; i++)
            {
                string flag = flags[i];
                if (flag == "-framework" && i + 1 < flags.Length &&
                    flags[i + 1] != null && Regex.IsMatch(flags[i + 1], @"\A[A-Za-z0-9_]+\z"))
                { i++; continue; }
                if (flag == null || !Regex.IsMatch(flag, @"\A-l[A-Za-z0-9_]+\z"))
                    throw new InvalidOperationException("Unsupported Devcel iOS linker requirement.");
            }
            string path = PBXProject.GetPBXProjectPath(output);
            var project = new PBXProject();
            project.ReadFromFile(path);
            // Unity 2021.3+ links IL2CPP into UnityFramework. Select one archive for the chosen SDK.
            const string projectPath = "Libraries/Devcel/libdevcel_runtime.a";
            string destination = Path.Combine(output, projectPath);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.Copy(archive, destination, true);
            string fileGuid = project.FindFileGuidByProjectPath(projectPath);
            if (string.IsNullOrEmpty(fileGuid)) fileGuid = project.AddFile(projectPath, projectPath, PBXSourceTree.Source);
            string framework = project.GetUnityFrameworkTargetGuid();
            project.AddFileToBuild(framework, fileGuid);
            project.AddBuildProperty(framework, "OTHER_LDFLAGS", string.Join(" ", flags));
            project.WriteToFile(path);
        }
    }
}
#endif
