using System;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace Devcel.Unity.Editor
{
    /// <summary>Automatically exports all projects before a Player build when enabled in settings.</summary>
    public class DevcelBuildHook : IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnPreprocessBuild(BuildReport report)
        {
            try
            {
                var settings = DevcelImporterSettings.Instance;
                // Disabling export must not disable distribution safety checks.
                DevcelDistributionValidation.Validate(settings, report.summary.platform);
                if (!settings.exportOnBuild) return;

                // Do not implicitly change activeEnvironment to Production, even for release builds.
                DevcelImporterSettings.Log("Running pre-build export… (env=" + settings.activeEnvironment + ")");
                if (!DevcelExporter.ExportAll(onlyAutoSync: false))
                    throw new BuildFailedException("Devcel export failed. Resolve the errors in the Importer before rebuilding.");
                if (settings.projects.Exists(project => project != null && project.lastExportCodeChanged))
                    throw new BuildFailedException("The generated Devcel C# code has changed. Wait for Unity to finish compiling before rebuilding.");
            }
            catch (BuildFailedException) { throw; }
            catch (Exception ex) { throw new BuildFailedException("Devcel distribution validation failed: " + ex.Message); }
        }
    }
}
