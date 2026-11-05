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
        [Serializable] private sealed class Requirements { public string[] link_flags; }

        [PostProcessBuild(100)]
        private static void Configure(BuildTarget target, string output)
        {
            if (target != BuildTarget.iOS) return;
            string root = DevcelPaths.DistributionRoot;
            string archive = Path.Combine(root, "Plugins/iOS/libdevcel_runtime.a");
            if (!File.Exists(archive)) return;
            DevcelNativePackage.ValidatePlayer(root, "Plugins/iOS/libdevcel_runtime.a");
            var requirements = JsonUtility.FromJson<Requirements>(File.ReadAllText(Path.Combine(root, "Tools~/Mobile/ios.json")));
            if (requirements?.link_flags == null || requirements.link_flags.Length == 0)
                throw new InvalidOperationException("Devcel iOS link requirements are missing. Reinstall the complete UPM tarball.");
            for (int i = 0; i < requirements.link_flags.Length; i++)
            {
                string flag = requirements.link_flags[i];
                if (flag == "-framework" && i + 1 < requirements.link_flags.Length &&
                    requirements.link_flags[i + 1] != null && Regex.IsMatch(requirements.link_flags[i + 1], @"\A[A-Za-z0-9_]+\z"))
                { i++; continue; }
                if (flag == null || !Regex.IsMatch(flag, @"\A-l[A-Za-z0-9_]+\z"))
                    throw new InvalidOperationException("Unsupported Devcel iOS linker requirement.");
            }
            string path = PBXProject.GetPBXProjectPath(output);
            var project = new PBXProject();
            project.ReadFromFile(path);
            // Unity 2021.3+ links native plugins and IL2CPP code into UnityFramework.
            project.AddBuildProperty(project.GetUnityFrameworkTargetGuid(), "OTHER_LDFLAGS", string.Join(" ", requirements.link_flags));
            project.WriteToFile(path);
        }
    }
}
#endif
