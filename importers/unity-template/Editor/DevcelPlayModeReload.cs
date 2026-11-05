using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>
    /// Generated bindings keep weak references to Open(path) databases. This bridge deliberately
    /// has no compile-time dependency on a user's generated namespace or Assembly-CSharp.
    /// </summary>
    internal static class DevcelPlayModeReload
    {
        private static readonly HashSet<string> warned = new HashSet<string>();

        public static void NotifyExport(DevcelProjectConfig project, DevcelImporterSettings settings,
            string bundlePath, bool schemaChanged)
        {
            if (!EditorApplication.isPlaying || !settings.reloadInPlayMode) return;
            if (schemaChanged)
            {
                DevcelImporterSettings.LogWarning($"{project.projectName}: Generated code has changed. The new schema will load the next time Play mode starts.");
                return;
            }
            string typeName = project.GetNamespace() + "." + project.GetClassName();
            bool found = false;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var type = assembly.GetType(typeName, throwOnError: false);
                    if (type == null) continue;
                    var reload = type.GetMethod("ReloadOpenDatabases", BindingFlags.Public | BindingFlags.Static,
                        null, new[] { typeof(string) }, null);
                    if (reload == null || reload.ReturnType != typeof(int)) continue;
                    found = true;
                    int count = (int)reload.Invoke(null, new object[] { bundlePath });
                    if (count > 0) DevcelImporterSettings.Log($"{project.projectName}: Hot-reloaded {count} open databases.");
                }
                catch (Exception ex)
                {
                    var cause = ex is TargetInvocationException invocation && invocation.InnerException != null
                        ? invocation.InnerException : ex;
                    DevcelImporterSettings.LogError($"{project.projectName}: Reload during Play mode failed: {cause.Message}");
                }
            }
            if (!found && warned.Add(typeName))
                DevcelImporterSettings.LogWarning($"{typeName}: ReloadOpenDatabases is missing. Regenerate the code with the latest CLI before resuming Play mode.");
        }
    }
}
