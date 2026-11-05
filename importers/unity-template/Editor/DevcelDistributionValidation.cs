using System;
using System.IO;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    internal static class DevcelDistributionValidation
    {
        internal static bool HasEditorFolder(string assetPath) =>
            ("/" + assetPath.Replace('\\', '/') + "/").IndexOf("/Editor/", StringComparison.OrdinalIgnoreCase) >= 0;

        internal static bool IsAutomaticallyIncluded(string assetPath)
        {
            string path = assetPath.Replace('\\', '/');
            // StreamingAssets is copied verbatim, including nested Editor/Resources folders.
            if (path.StartsWith("Assets/StreamingAssets/", StringComparison.OrdinalIgnoreCase)) return true;
            if (HasEditorFolder(path)) return false;
            return ("/" + path + "/").IndexOf("/Resources/", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        internal static void Validate(DevcelImporterSettings settings, BuildTarget target)
        {
            foreach (string guid in AssetDatabase.FindAssets("t:DevcelImporterSettings"))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (!HasEditorFolder(path) || path.StartsWith("Assets/StreamingAssets/", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Editor settings may be included in the Player. Place the settings asset in an Editor folder (no automatic changes will be made): " + path);
            }
            // FindAssets cannot see every unrecognized extension; inspect known authoring/CLI names on disk too.
            string assets = UnityEngine.Application.dataPath;
            if (Directory.Exists(assets))
                foreach (string file in Directory.EnumerateFiles(assets, "*", SearchOption.AllDirectories))
                {
                    string path = "Assets/" + file.Substring(assets.TrimEnd(Path.DirectorySeparatorChar).Length + 1).Replace('\\', '/');
                    if (!IsAutomaticallyIncluded(path)) continue;
                    string name = Path.GetFileName(file).ToLowerInvariant();
                    if (name == "devcel" || name == "devcel.exe" || name == "devcel.export.toml" ||
                        name == "devcelimportersettings.asset" || IsAuthoringLibrary(name) || name.EndsWith(".devcelproj.toml", StringComparison.Ordinal) ||
                        name.EndsWith(".table.toml", StringComparison.Ordinal) || name.EndsWith(".interface.toml", StringComparison.Ordinal))
                        throw new InvalidOperationException("Devcel CLI/editor data cannot be placed in Resources / StreamingAssets: " + path);
                }
            foreach (var importer in PluginImporter.GetAllImporters())
            {
                string name = Path.GetFileName(importer.assetPath).ToLowerInvariant();
                if (IsAuthoringLibrary(name) &&
                    (importer.GetCompatibleWithAnyPlatform() || importer.GetCompatibleWithPlatform(target)))
                    throw new InvalidOperationException("Devcel editor libraries cannot be included in the Player. Configure them for Editor use only: " + importer.assetPath);
            }
            if (settings.projects == null) throw new InvalidOperationException("The Devcel project settings list is missing.");
            foreach (var project in settings.projects)
            {
                if (project == null) throw new InvalidOperationException("Devcel project settings contain null.");
                if (!DevcelConfigValidation.ValidateEnvironments(project, settings.activeEnvironment, out string error))
                    throw new InvalidOperationException(project.projectName + ": " + error);
                RejectShippingLocation(project.devcelProjectPath, "authoring source");
            }
            bool runtimeRequired = settings.projects.Count > 0;
            foreach (string guid in AssetDatabase.FindAssets("t:DevcelDatabaseAsset"))
            {
                var database = AssetDatabase.LoadAssetAtPath<Devcel.Unity.DevcelDatabaseAsset>(AssetDatabase.GUIDToAssetPath(guid));
                if (database == null) throw new InvalidOperationException("Cannot read the Devcel runtime database asset: " + guid);
                database.ValidateSources();
                foreach (var source in database.Sources)
                {
                    // TextAsset references also become Player dependencies. Reject authoring data or
                    // invalid bundles even when the importer has no configured authoring projects.
                    using (source.bundle != null
                        ? DevcelPreviewData.FromJson(source.bundle.text)
                        : DevcelPreviewData.Open(Devcel.Unity.DevcelBundle.ResolveStreamingAssetsPath(source.streamingAssetsPath))) { }
                }
                runtimeRequired |= database.ProjectCount > 0;
            }
            DevcelNativePlugins.ValidateForBuild(target, runtimeRequired);
        }

        private static bool IsAuthoringLibrary(string name) =>
            name == "devcel_core.dll" || name == "libdevcel_core.so" ||
            name == "libdevcel_core.dylib" || name == "devcel_core.dylib" || name == "devcel.authoring.dll";

        private static void RejectShippingLocation(string configuredPath, string kind)
        {
            string full = DevcelPaths.ResolveFromProjectRoot(configuredPath).Replace('\\', '/');
            string assets = UnityEngine.Application.dataPath.Replace('\\', '/').TrimEnd('/') + "/";
            if (full.StartsWith(assets, StringComparison.OrdinalIgnoreCase) &&
                IsAutomaticallyIncluded("Assets/" + full.Substring(assets.Length)))
                throw new InvalidOperationException("Devcel " + kind + " must be placed outside Resources / StreamingAssets: " + configuredPath);
        }
    }
}
