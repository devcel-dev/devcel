using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>asmdef is for managed code. Restrict native distribution targets separately with PluginImporter.</summary>
    [InitializeOnLoad]
    internal static class DevcelNativePlugins
    {
        internal sealed class Rule
        {
            internal readonly string Path, OS, CPU;
            internal readonly BuildTarget Target;
            internal Rule(string path, string os, string cpu, BuildTarget target)
            { Path = path; OS = os; CPU = cpu; Target = target; }
        }

        internal static readonly Rule[] Rules =
        {
            new Rule("Plugins/Windows/x86_64/devcel_runtime.dll", "Windows", "x86_64", BuildTarget.StandaloneWindows64),
            new Rule("Plugins/Linux/x86_64/libdevcel_runtime.so", "Linux", "x86_64", BuildTarget.StandaloneLinux64),
            new Rule("Plugins/macOS/libdevcel_runtime.dylib", "OSX", "AnyCPU", BuildTarget.StandaloneOSX),
            new Rule("Plugins/Android/arm64-v8a/libdevcel_runtime.so", "", "ARM64", BuildTarget.Android),
            new Rule("Plugins/iOS/libdevcel_runtime.a", "", "ARM64", BuildTarget.iOS),
        };

        static DevcelNativePlugins() { EditorApplication.delayCall += RepairInstalled; }

        [MenuItem("Devcel/Repair Native Plugin Settings", priority = 40)]
        internal static void RepairInstalled()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            { EditorApplication.delayCall += RepairInstalled; return; }
            try
            {
                foreach (var importer in PluginImporter.GetAllImporters())
                {
                    var rule = FindRule(importer.assetPath);
                    if (rule != null && Apply(importer, rule)) importer.SaveAndReimport();
                }
            }
            catch (Exception ex) { DevcelImporterSettings.LogError("Cannot apply native settings: " + ex.Message); }
        }

        internal static Rule FindRule(string assetPath)
        {
            string root = DevcelPaths.NativeAssetRoot;
            if (string.IsNullOrEmpty(root)) return null;
            foreach (var rule in Rules)
                if (string.Equals(assetPath.Replace('\\', '/'), root + "/" + rule.Path, StringComparison.Ordinal)) return rule;
            return null;
        }

        internal static IEnumerable<BuildTarget> PlayerTargets()
        {
            var seen = new HashSet<BuildTarget>();
            foreach (var field in typeof(BuildTarget).GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
            {
                if (Attribute.IsDefined(field, typeof(ObsoleteAttribute))) continue;
                var target = (BuildTarget)field.GetValue(null);
                if ((int)target > 0 && seen.Add(target)) yield return target;
            }
        }

        internal static bool Matches(PluginImporter importer, Rule rule)
        {
            bool editor = rule.OS.Length != 0;
            if (!importer.isNativePlugin || importer.GetCompatibleWithAnyPlatform() || importer.GetCompatibleWithEditor() != editor ||
                (editor && (importer.GetEditorData("OS") != rule.OS || importer.GetEditorData("CPU") != rule.CPU)) ||
                importer.GetPlatformData(rule.Target, "CPU") != rule.CPU || importer.isPreloaded ||
                (importer.DefineConstraints != null && importer.DefineConstraints.Length != 0)) return false;
            foreach (BuildTarget target in PlayerTargets())
                if (importer.GetCompatibleWithPlatform(target) != (target == rule.Target)) return false;
            return true;
        }

        internal static bool Apply(PluginImporter importer, Rule rule)
        {
            if (!importer.isNativePlugin) return false; // Do not treat managed DLLs as native plugins.
            if (Matches(importer, rule)) return false;
            importer.SetCompatibleWithAnyPlatform(false);
            importer.SetCompatibleWithEditor(rule.OS.Length != 0);
            importer.SetEditorData("OS", rule.OS.Length != 0 ? rule.OS : "AnyOS");
            importer.SetEditorData("CPU", rule.OS.Length != 0 ? rule.CPU : "AnyCPU");
            importer.SetEditorData("DefaultValueInitialized", "true");
            foreach (BuildTarget target in PlayerTargets()) importer.SetCompatibleWithPlatform(target, target == rule.Target);
            importer.SetPlatformData(rule.Target, "CPU", rule.CPU);
            importer.isPreloaded = false;
            importer.DefineConstraints = Array.Empty<string>();
            return true;
        }

        internal static bool IsRuntimeFile(string path)
        {
            string name = System.IO.Path.GetFileName(path).ToLowerInvariant();
            return name == "devcel_runtime.dll" || name == "libdevcel_runtime.so" ||
                name == "devcel_runtime.dylib" || name == "libdevcel_runtime.dylib" || name == "libdevcel_runtime.a";
        }

        internal static void ValidateForBuild(BuildTarget target, bool runtimeRequired)
        {
            Rule required = null;
            foreach (var rule in Rules) if (rule.Target == target) required = rule;
            if (runtimeRequired && required == null)
                throw new InvalidOperationException("Devcel native runtime supports Windows x64, Linux x64, macOS universal, Android ARM64 and iOS ARM64 devices. Unsupported target: " + target);
            if (runtimeRequired && target == BuildTarget.Android &&
                (PlayerSettings.Android.targetArchitectures != AndroidArchitecture.ARM64 || (int)PlayerSettings.Android.minSdkVersion < 23))
                throw new InvalidOperationException("Devcel Android runtime requires only ARM64 and Minimum API Level 23 or later. Other Android ABIs are not bundled.");
            if (runtimeRequired && target == BuildTarget.iOS &&
                (PlayerSettings.iOS.sdkVersion != iOSSdkVersion.DeviceSDK ||
                 !Version.TryParse(PlayerSettings.iOS.targetOSVersionString, out Version minimum) || minimum < new Version(13, 0)))
                throw new InvalidOperationException("Devcel iOS runtime requires Device SDK (ARM64) and iOS 13.0 or later. Simulator libraries are not bundled.");
            if (runtimeRequired || DevcelPaths.DistributionRoot != DevcelPaths.PackageRoot) DevcelNativePackage.Validate(DevcelPaths.DistributionRoot, requireCli: false);
            bool found = false;
            foreach (var importer in PluginImporter.GetAllImporters())
            {
                var rule = FindRule(importer.assetPath);
                if (rule != null)
                {
                    if (!Matches(importer, rule))
                        throw new InvalidOperationException("The native PluginImporter OS/CPU/distribution settings are invalid. Run Devcel > Repair Native Plugin Settings: " + importer.assetPath);
                    if (runtimeRequired && rule == required)
                    {
                        if (rule.OS.Length == 0) DevcelNativePackage.ValidatePlayer(DevcelPaths.DistributionRoot, rule.Path);
                        if (!DevcelNativeBinary.Validate(System.IO.Path.Combine(DevcelPaths.DistributionRoot, rule.Path), rule.Target, out string error))
                            throw new InvalidOperationException(error);
                        found = true;
                    }
                }
                else if (IsRuntimeFile(importer.assetPath) &&
                    (importer.GetCompatibleWithAnyPlatform() || importer.GetCompatibleWithPlatform(target)))
                    throw new InvalidOperationException("Duplicate or unmanaged Devcel runtime found. Place it in the corresponding package Plugins folder: " + importer.assetPath);
            }
            if (runtimeRequired && !found)
                throw new InvalidOperationException("Devcel runtime for the Player is missing: " + required.Path + " (provide the actual binary built on the supported OS and its .meta file)");
        }
    }

    internal sealed class DevcelNativePluginPostprocessor : AssetPostprocessor
    {
        private void OnPreprocessAsset()
        {
            var importer = assetImporter as PluginImporter;
            if (importer == null) return;
            var rule = DevcelNativePlugins.FindRule(assetPath);
            if (rule != null) DevcelNativePlugins.Apply(importer, rule);
        }
    }
}
