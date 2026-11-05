using System;
using UnityEngine;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Manages status and synchronization for multiple source projects. Uses the same wizard to add and edit source projects.</summary>
    public class DevcelImporterWindow : EditorWindow
    {
        private Vector2 scroll;
        private bool showGeneral, busy;
        private int session;
        private string status;

        [MenuItem("Devcel/Importer", priority = 0)]
        public static void Open()
        {
            var window = GetWindow<DevcelImporterWindow>("Devcel Importer");
            window.minSize = new Vector2(520, 400);
            window.Show();
        }

        [MenuItem("Devcel/Import All", priority = 1)]
        public static void ExportNowMenu() => DevcelExporter.ExportAll(onlyAutoSync: false);

        private void OnDisable() { session++; busy = false; }

        private void Queue(Action action)
        {
            if (busy) return;
            busy = true;
            int requestedSession = session;
            Repaint();
            EditorApplication.delayCall += () =>
            {
                if (this == null || requestedSession != session) return;
                try { action(); }
                catch (Exception ex) { status = ex.Message; }
                finally { busy = false; if (this != null) Repaint(); }
            };
        }

        internal static bool ValidateEnvironmentSelection(DevcelImporterSettings settings, DevcelEnvironment environment, out string error)
        {
            error = null;
            foreach (var project in settings.projects)
            {
                if (project == null)
                { error = "Some source project settings are invalid. Fix them before changing the environment."; return false; }
                if (!DevcelConfigValidation.ValidateEnvironments(project, environment, out string detail))
                {
                    error = project.projectName + ": " + detail + "\nThe environment has not changed. Keep the current environment, open 'Edit Settings…' for each source project, and use 'Versions for All Environments' under generation settings to configure " +
                        environment + " before switching.";
                    return false;
                }
            }
            return true;
        }

        private void DrawGeneral(DevcelImporterSettings settings)
        {
            EditorGUILayout.LabelField("Current environment: " + settings.activeEnvironment + "  /  Auto-import: " + settings.syncMode, EditorStyles.miniBoldLabel);
            showGeneral = EditorGUILayout.Foldout(showGeneral, "Shared Settings (Environment / Auto-import)");
            if (!showGeneral) return;
            var previousEnvironment = settings.activeEnvironment;
            var previousSyncMode = settings.syncMode;
            bool previousExportOnBuild = settings.exportOnBuild;
            bool previousReload = settings.reloadInPlayMode;
            EditorGUI.BeginChangeCheck();
            var selectedEnvironment = (DevcelEnvironment)EditorGUILayout.EnumPopup("Current environment", settings.activeEnvironment);
            settings.syncMode = (DevcelSyncMode)EditorGUILayout.EnumPopup("Auto-import mode", settings.syncMode);
            EditorGUILayout.HelpBox("In Auto (default) / P2P mode, the bundled CLI automatically starts and shares the server. Auto also monitors saved files while disconnected.", MessageType.Info);
            settings.exportOnBuild = EditorGUILayout.Toggle("Also import before builds (optional)", settings.exportOnBuild);
            settings.reloadInPlayMode = EditorGUILayout.Toggle("Hot-reload in Play mode", settings.reloadInPlayMode);
            if (EditorGUI.EndChangeCheck())
            {
                try
                {
                    if (selectedEnvironment != previousEnvironment &&
                        !ValidateEnvironmentSelection(settings, selectedEnvironment, out string environmentError))
                        throw new InvalidOperationException(environmentError);
                    settings.activeEnvironment = selectedEnvironment;
                    settings.Save();
                    status = null;
                }
                catch (Exception ex)
                {
                    settings.activeEnvironment = previousEnvironment;
                    settings.syncMode = previousSyncMode;
                    settings.exportOnBuild = previousExportOnBuild;
                    settings.reloadInPlayMode = previousReload;
                    status = ex.Message;
                }
            }
        }

        private static string ImportStatusLabel(string value) => value switch
        {
            "pulled" => "Imported",
            "ready" => "Up to date",
            "needs_pull" => "Import required",
            "error" => "Error",
            _ => value,
        };

        private void OnGUI()
        {
            var settings = DevcelImporterSettings.Instance;
            scroll = EditorGUILayout.BeginScrollView(scroll);
            EditorGUILayout.LabelField("Devcel Importer", EditorStyles.boldLabel);
            using (new EditorGUI.DisabledScope(busy))
            {
                if (GUILayout.Button("+ Add Source Project…", GUILayout.Height(30))) DevcelSetupWizard.Open();
                DrawGeneral(settings);
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Registered Source Projects", EditorStyles.boldLabel);
                if (settings.projects.Count == 0)
                    EditorGUILayout.HelpBox("No source projects have been registered yet.", MessageType.Info);
                int removeIndex = -1;
                for (int i = 0; i < settings.projects.Count; i++)
                {
                    var project = settings.projects[i];
                    EditorGUILayout.BeginVertical(EditorStyles.helpBox);
                    if (project == null)
                    {
                        EditorGUILayout.HelpBox("Invalid source project settings. Remove the entry and add it again.", MessageType.Error);
                        if (GUILayout.Button("Remove Invalid Entry")) removeIndex = i;
                    }
                    else
                    {
                        EditorGUILayout.LabelField(project.projectName, EditorStyles.boldLabel);
                        EditorGUILayout.LabelField("Source project", project.devcelProjectPath, EditorStyles.wordWrappedLabel);
                        EditorGUILayout.LabelField("Generated type", project.GetNamespace() + "." + project.GetClassName(), EditorStyles.wordWrappedLabel);
                        EditorGUILayout.LabelField("Code", project.GetCodeOutputFolder() + "/Devcel.cs", EditorStyles.wordWrappedLabel);
                        EditorGUILayout.LabelField("JSON", project.GetJsonOutputFolder() + "/" + project.bundleFileName, EditorStyles.wordWrappedLabel);
                        if (!project.TryValidate(settings, out string configError)) EditorGUILayout.HelpBox(configError, MessageType.Warning);
                        var version = project.environments?.Find(item => item != null && item.environment == settings.activeEnvironment);
                        EditorGUILayout.LabelField("Version: " + (version == null ? "Not set" : version.contentVersion == -1 ? "-1 (all records)" : version.contentVersion.ToString()), EditorStyles.miniLabel);
                        EditorGUILayout.LabelField("Sync: " + DevcelChangeWatcher.GetStatus(project), EditorStyles.miniLabel);
                        string syncError = DevcelChangeWatcher.GetError(project);
                        if (!string.IsNullOrEmpty(syncError)) EditorGUILayout.HelpBox(syncError, MessageType.Warning);
                        EditorGUILayout.LabelField("Import status: " + ImportStatusLabel(project.lastPullStatus), EditorStyles.miniLabel);
                        if (!string.IsNullOrEmpty(project.lastError)) EditorGUILayout.HelpBox(project.lastError, MessageType.Error);
                        else if (project.lastExport != default) EditorGUILayout.LabelField($"Last import: {project.lastExport:yyyy-MM-dd HH:mm:ss}", EditorStyles.miniLabel);
                        EditorGUILayout.BeginHorizontal();
                        if (GUILayout.Button("Edit Settings…")) DevcelSetupWizard.Open(project);
                        if (GUILayout.Button("Import")) Queue(() =>
                        {
                            status = DevcelExporter.ExportProject(project, settings) ? project.projectName + " imported successfully." : project.lastError;
                        });
                        if (GUILayout.Button("Preview")) DevcelPreviewWindow.Open(project);
                        if (GUILayout.Button("Remove Entry")) removeIndex = i;
                        EditorGUILayout.EndHorizontal();
                    }
                    EditorGUILayout.EndVertical();
                    EditorGUILayout.Space();
                }
                if (removeIndex >= 0)
                {
                    var removed = settings.projects[removeIndex];
                    settings.projects.RemoveAt(removeIndex);
                    try { settings.Save(); status = "Removed the entry. The source project and generated files are unchanged."; }
                    catch (Exception ex) { settings.projects.Insert(removeIndex, removed); status = ex.Message; }
                }
                using (new EditorGUI.DisabledScope(settings.projects.Count == 0))
                {
                    EditorGUILayout.BeginHorizontal();
                    if (GUILayout.Button("Check Status and Errors")) Queue(() => DevcelExporter.CheckStatus(settings));
                    if (GUILayout.Button("Import All", GUILayout.Height(30))) Queue(() =>
                    {
                        status = DevcelExporter.ExportAll(onlyAutoSync: false) ? "All source projects imported successfully." : "Some source projects failed to import. Check the errors for each source project.";
                    });
                    EditorGUILayout.EndHorizontal();
                }
            }
            if (busy) EditorGUILayout.HelpBox("Processing. Please wait until it finishes.", MessageType.Info);
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);
            EditorGUILayout.EndScrollView();
        }
    }
}
