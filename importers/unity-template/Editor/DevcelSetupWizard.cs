using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>Edits a draft import configuration across three screens. Does not save or import until the final explicit action.</summary>
    public sealed class DevcelSetupWizard : EditorWindow
    {
        internal enum Step { Source, Generation, Review }
        private static readonly string[] StepNames = { "Select Source", "Generation Settings", "Review and Import" };
        private DevcelProjectConfig project;
        private DevcelProjectConfig original;
        private string originalSnapshot;
        private DevcelEnvironment activeEnvironment;
        private string status;
        private bool busy, completed;
        private bool showOtherEnvironments;
        private int session;
        private Step step;
        private Vector2 scroll;

        [MenuItem("Devcel/Setup Wizard", priority = 2)]
        public static void Open() => Open(null);

        public static void Open(DevcelProjectConfig existing)
        {
            var window = GetWindow<DevcelSetupWizard>("Devcel Setup");
            window.minSize = new Vector2(600, 530);
            // A second open cannot replace an operation already queued or running.
            if (!window.busy) window.Begin(existing);
            window.Show();
            window.Focus();
        }

        private void OnEnable()
        {
            // Domain reload must not resurrect a stale in-progress draft or repeat a completed import.
            project = null;
            session++;
            busy = false;
        }

        private void OnDisable() { session++; busy = false; }

        private void Begin(DevcelProjectConfig existing)
        {
            session++;
            var settings = DevcelImporterSettings.Instance;
            original = existing;
            originalSnapshot = existing == null ? null : JsonUtility.ToJson(existing);
            project = CloneProject(existing);
            if (existing == null)
            {
                project.projectName = "MyGame";
                int suffix = 2;
                while (settings.projects.Exists(item => item != null && string.Equals(item.projectName, project.projectName, StringComparison.OrdinalIgnoreCase)))
                    project.projectName = "MyGame" + suffix++;
            }
            activeEnvironment = settings.activeEnvironment;
            step = Step.Source;
            completed = busy = showOtherEnvironments = false;
            status = null;
            scroll = Vector2.zero;
        }

        internal static DevcelProjectConfig CloneProject(DevcelProjectConfig source)
        {
            if (source == null) return new DevcelProjectConfig();
            // Explicit deep copy also preserves null/duplicate entries for validation, never repairing silently.
            var copy = new DevcelProjectConfig
            {
                projectName = source.projectName,
                devcelProjectPath = source.devcelProjectPath,
                codeOutputFolder = source.codeOutputFolder,
                jsonOutputFolder = source.jsonOutputFolder,
                bundleFileName = source.bundleFileName,
                codeNamespace = source.codeNamespace,
                codeClassName = source.codeClassName,
                row_include_tags = source.row_include_tags == null ? null : new List<string>(source.row_include_tags),
                row_exclude_tags = source.row_exclude_tags == null ? null : new List<string>(source.row_exclude_tags),
                column_include_tags = source.column_include_tags == null ? null : new List<string>(source.column_include_tags),
                column_exclude_tags = source.column_exclude_tags == null ? null : new List<string>(source.column_exclude_tags),
                minimal = source.minimal,
                autoSync = source.autoSync,
                lastContentHash = source.lastContentHash,
                lastPullStatus = source.lastPullStatus,
                lastExport = source.lastExport,
                lastError = source.lastError,
                lastExportCodeChanged = source.lastExportCodeChanged,
                environments = source.environments == null ? null : new List<DevcelEnvironmentVersion>()
            };
            if (source.environments != null)
                foreach (var value in source.environments)
                    copy.environments.Add(value == null ? null : new DevcelEnvironmentVersion
                    { environment = value.environment, contentVersion = value.contentVersion });
            return copy;
        }

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

        internal static bool ValidateSource(DevcelProjectConfig draft, DevcelImporterSettings settings,
            DevcelProjectConfig replacing, out string error)
        {
            error = null;
            try
            {
                if (draft == null || !Regex.IsMatch(draft.projectName ?? string.Empty, "^[A-Za-z0-9_-]+$"))
                { error = "Source ID must contain only letters, digits, underscores, or hyphens."; return false; }
                if (settings.projects.Exists(item => item != null && !ReferenceEquals(item, replacing) &&
                    string.Equals(item.projectName, draft.projectName, StringComparison.OrdinalIgnoreCase)))
                { error = "The Source ID conflicts with another source project."; return false; }
                if (string.IsNullOrWhiteSpace(draft.devcelProjectPath))
                { error = "Select the source project's .devcelproj.toml file."; return false; }
                string path = DevcelPaths.ResolveFromProjectRoot(draft.devcelProjectPath);
                // Prove it is portable before advancing; do not mutate the draft or settings here.
                DevcelPaths.ToProjectRelative(draft.devcelProjectPath);
                if (Directory.Exists(path))
                {
                    if (Directory.GetFiles(path, "*.devcelproj.toml", SearchOption.TopDirectoryOnly).Length == 1) return true;
                    error = "The selected directory must contain exactly one .devcelproj.toml file. Select the file directly.";
                }
                else if (File.Exists(path) && path.EndsWith(".devcelproj.toml", StringComparison.OrdinalIgnoreCase)) return true;
                else error = "Specify an existing .devcelproj.toml file or a directory containing one.";
                return false;
            }
            catch (Exception ex) { error = ex.Message; return false; }
        }

        internal static bool ValidateDraft(DevcelProjectConfig draft, DevcelImporterSettings settings,
            DevcelProjectConfig replacing, out string error)
        {
            error = null;
            var temporary = CreateInstance<DevcelImporterSettings>();
            try
            {
                temporary.activeEnvironment = settings.activeEnvironment;
                temporary.projects = new List<DevcelProjectConfig>(settings.projects);
                if (replacing != null)
                {
                    int index = temporary.projects.IndexOf(replacing);
                    if (index < 0) { error = "The item being edited was deleted. Reopen it from the Importer."; return false; }
                    temporary.projects[index] = draft;
                }
                else temporary.projects.Add(draft);
                DevcelPaths.ToProjectRelative(draft.devcelProjectPath);
                DevcelPaths.ToProjectRelative(draft.codeOutputFolder);
                DevcelPaths.ToProjectRelative(draft.jsonOutputFolder);
                // Exporter publishes a whole multi-source manifest: reject any invalid source before saving.
                foreach (var candidate in temporary.projects)
                    if (candidate == null || !candidate.TryValidate(temporary, out error))
                    {
                        if (candidate == null) error = "The source project settings are null. Check them in the Importer.";
                        return false;
                    }
                error = null;
                return true;
            }
            catch (Exception ex) { error = ex.Message; return false; }
            finally { DestroyImmediate(temporary); }
        }

        private bool ValidateSession(out string error)
        {
            var settings = DevcelImporterSettings.Instance;
            if (settings.activeEnvironment != activeEnvironment)
            { error = "The current environment was changed in the Importer. Reopen the settings and check the environment and version."; return false; }
            if (original != null && (!settings.projects.Contains(original) || JsonUtility.ToJson(original) != originalSnapshot))
            { error = "The source project settings being edited were changed or deleted in another window. Reopen them from the Importer."; return false; }
            error = null;
            return true;
        }

        private bool CanAdvance(out string error)
        {
            if (!ValidateSession(out error)) return false;
            if (!ValidateSource(project, DevcelImporterSettings.Instance, original, out error)) return false;
            return step == Step.Source || ValidateDraft(project, DevcelImporterSettings.Instance, original, out error);
        }

        private void RegisterAndExport()
        {
            if (completed || step != Step.Review || !ValidateSession(out status)) return;
            var settings = DevcelImporterSettings.Instance;
            if (!ValidateDraft(project, settings, original, out status)) return;
            // Bundled tooling is an internal prerequisite, never a user-selected setup step.
            // Verify at the commit boundary so a broken package cannot save a registration.
            if (!DevcelCliRunner.ValidateBundledCli(out status)) return;
            var committed = CloneProject(project);
            committed.devcelProjectPath = DevcelPaths.ToProjectRelative(committed.devcelProjectPath);
            committed.codeOutputFolder = DevcelPaths.ToProjectRelative(committed.codeOutputFolder);
            committed.jsonOutputFolder = DevcelPaths.ToProjectRelative(committed.jsonOutputFolder);
            int index = original == null ? -1 : settings.projects.IndexOf(original);
            if (index < 0) settings.projects.Add(committed);
            else settings.projects[index] = committed;
            try { settings.Save(); }
            catch
            {
                if (index < 0) settings.projects.Remove(committed);
                else settings.projects[index] = original;
                throw;
            }
            // Save occurs only after final consent. A failed import keeps this valid registration for retry.
            original = committed;
            originalSnapshot = JsonUtility.ToJson(committed);
            project = CloneProject(committed);
            if (!DevcelExporter.ExportProject(committed, settings))
            {
                status = "Settings were saved, but the import failed. Fix the cause and try again.\n" + committed.lastError;
                return;
            }
            completed = true;
            status = "Import complete. Once the generated code finishes compiling, you can open the preview from the Importer.";
            try
            {
                using (DevcelPreviewData.Open(Path.Combine(DevcelPaths.ToAbsolute(committed.GetJsonOutputFolder()), committed.bundleFileName))) { }
                status += "\nLoading the Editor runtime library was also verified.";
            }
            catch (Exception ex) { status += "\nImport succeeded. Check the placement of devcel_runtime for previews: " + ex.Message; }
        }

        // Apply only an explicitly requested environment entry to the draft.
        internal static bool TrySetEnvironmentVersion(DevcelProjectConfig target, DevcelEnvironment environment, long value, out string error)
        {
            error = null;
            if (value < -1 || value > uint.MaxValue)
            { error = "Version must be -1 (all records) or 0..4294967295."; return false; }
            if (target == null || target.environments == null)
            { error = "No environment settings are available."; return false; }
            var matches = target.environments.FindAll(item => item != null && item.environment == environment);
            if (matches.Count > 1)
            { error = "Duplicate environment settings. Fix them in Generation Settings."; return false; }
            if (matches.Count == 0)
                target.environments.Add(new DevcelEnvironmentVersion { environment = environment, contentVersion = value });
            else matches[0].contentVersion = value;
            return true;
        }

        private void DrawSource()
        {
            project.projectName = EditorGUILayout.TextField(new GUIContent("Source ID", "A unique ID that distinguishes source projects. Use letters, digits, underscores, or hyphens."), project.projectName);
            project.devcelProjectPath = EditorGUILayout.DelayedTextField("Source project", project.devcelProjectPath);
            if (GUILayout.Button("Select .devcelproj.toml…"))
            {
                string picked = EditorUtility.OpenFilePanel("Select Source Project .devcelproj.toml", DevcelPaths.ProjectRoot, "toml");
                if (!string.IsNullOrEmpty(picked))
                {
                    try { project.devcelProjectPath = DevcelPaths.ToProjectRelative(picked); status = null; }
                    catch (Exception ex) { status = ex.Message; }
                }
            }
        }

        private void DrawGeneration()
        {
            project.codeNamespace = EditorGUILayout.TextField("Namespace (blank for automatic)", project.codeNamespace);
            project.codeClassName = EditorGUILayout.TextField("Root class name (blank for default)", project.codeClassName);
            project.codeOutputFolder = EditorGUILayout.DelayedTextField("Code output (under Assets)", project.codeOutputFolder);
            project.jsonOutputFolder = EditorGUILayout.DelayedTextField("JSON output", project.jsonOutputFolder);
            project.bundleFileName = EditorGUILayout.TextField("Bundle filename", project.bundleFileName);
            DevcelTagFilters.Draw(project);
            project.minimal = EditorGUILayout.Toggle("Minimal mode", project.minimal);
            project.autoSync = EditorGUILayout.Toggle("Auto-import", project.autoSync);
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Environment for this import: " + activeEnvironment, EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Content version -1 includes all records; 0..4294967295 applies a numeric filter. This does not change the shared environment selection.", MessageType.Info);
            if (project.environments == null)
            {
                EditorGUILayout.HelpBox("No environment settings are available. Add and configure them.", MessageType.Warning);
                if (GUILayout.Button("Create Environment Settings")) project.environments = new List<DevcelEnvironmentVersion>();
            }
            else
            {
                var active = project.environments.FindAll(item => item != null && item.environment == activeEnvironment);
                if (active.Count == 1) active[0].contentVersion = EditorGUILayout.LongField("Version for this import (-1 = all records)", active[0].contentVersion);
                else if (active.Count == 0)
                {
                    EditorGUILayout.HelpBox("This environment is not registered. Add it explicitly even when including all records.", MessageType.Warning);
                    if (GUILayout.Button(activeEnvironment + ": Add (-1 = all records)"))
                        TrySetEnvironmentVersion(project, activeEnvironment, -1, out status);
                }
                EditorGUILayout.LabelField("Before switching to another environment, add it to the list below.", EditorStyles.wordWrappedLabel);
                showOtherEnvironments = EditorGUILayout.Foldout(showOtherEnvironments, "Versions for All Environments");
                if (showOtherEnvironments)
                {
                    int remove = -1;
                    for (int i = 0; i < project.environments.Count; i++)
                    {
                        var value = project.environments[i];
                        EditorGUILayout.BeginHorizontal();
                        if (value == null) EditorGUILayout.LabelField("Invalid environment settings");
                        else
                        {
                            value.environment = (DevcelEnvironment)EditorGUILayout.EnumPopup(value.environment);
                            value.contentVersion = EditorGUILayout.LongField(value.contentVersion);
                        }
                        if (GUILayout.Button("Delete", GUILayout.Width(50))) remove = i;
                        EditorGUILayout.EndHorizontal();
                    }
                    if (remove >= 0) project.environments.RemoveAt(remove);
                    if (GUILayout.Button("Add Environment")) project.environments.Add(new DevcelEnvironmentVersion());
                }
            }
            DrawOutputs();
        }

        private void DrawOutputs()
        {
            EditorGUILayout.HelpBox("Generated type: " + project.GetNamespace() + "." + project.GetClassName() +
                "\nCode: " + project.GetCodeOutputFolder() + "/Devcel.cs" +
                "\nJSON: " + project.GetJsonOutputFolder() + "/" + project.bundleFileName, MessageType.Info);
        }

        private void DrawReview()
        {
            EditorGUILayout.LabelField(original == null ? "Register New Source Project" : "Update Registered Source Project", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Source ID", project.projectName);
            EditorGUILayout.LabelField("Source project", project.devcelProjectPath, EditorStyles.wordWrappedLabel);
            EditorGUILayout.LabelField("Environment", activeEnvironment.ToString());
            var version = project.environments?.Find(item => item != null && item.environment == activeEnvironment);
            EditorGUILayout.LabelField("row include tags", project.row_include_tags == null ? "Invalid null array" : string.Join(", ", project.row_include_tags));
            EditorGUILayout.LabelField("row exclude tags", project.row_exclude_tags == null ? "Invalid null array" : string.Join(", ", project.row_exclude_tags));
            EditorGUILayout.LabelField("column include tags", project.column_include_tags == null ? "Invalid null array" : string.Join(", ", project.column_include_tags));
            EditorGUILayout.LabelField("column exclude tags", project.column_exclude_tags == null ? "Invalid null array" : string.Join(", ", project.column_exclude_tags));
            EditorGUILayout.LabelField("Content version", version == null ? "Not set" : version.contentVersion == -1 ? "-1 (all records)" : version.contentVersion.ToString());
            EditorGUILayout.LabelField("Generation mode", project.minimal ? "Minimal" : "Full");
            EditorGUILayout.LabelField("Auto-import", project.autoSync ? "Enabled (shared setting: " + DevcelImporterSettings.Instance.syncMode + ")" : "Disabled");
            DrawOutputs();
            if (!completed) EditorGUILayout.HelpBox("Updates the generated code and JSON. Settings are saved even if the import fails, so you can try again.", MessageType.Info);
        }

        private void DrawRestartRequired()
        {
            EditorGUILayout.LabelField("Devcel · Reopen Settings", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Unconfirmed input was discarded because of compilation or a window reload. Reselect the source project in the Importer. You can also check saved settings and import results there.", MessageType.Info);
            if (GUILayout.Button("Open Importer")) { DevcelImporterWindow.Open(); Close(); }
            if (GUILayout.Button("Close")) Close();
        }

        private void OnGUI()
        {
            // Never turn a reloaded edit/completion window into a new-source registration.
            // Only the explicit Open entry points may initialize a new draft.
            if (project == null) { DrawRestartRequired(); return; }
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Devcel · Import Settings", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(((int)step + 1) + " / 3  " + StepNames[(int)step], EditorStyles.boldLabel);
            EditorGUILayout.Space();
            scroll = EditorGUILayout.BeginScrollView(scroll);
            using (new EditorGUI.DisabledScope(busy || completed))
            {
                EditorGUI.BeginChangeCheck();
                switch (step)
                {
                    case Step.Source: DrawSource(); break;
                    case Step.Generation: DrawGeneration(); break;
                    case Step.Review: DrawReview(); break;
                }
                if (EditorGUI.EndChangeCheck()) status = null;
            }
            bool ready = CanAdvance(out string error);
            if (!completed && !ready && !string.IsNullOrEmpty(error)) EditorGUILayout.HelpBox(error, MessageType.Warning);
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, completed ? MessageType.Info : MessageType.Warning);
            if (busy) EditorGUILayout.HelpBox("Processing. Please wait until it finishes.", MessageType.Info);
            EditorGUILayout.EndScrollView();
            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(busy))
            {
                EditorGUILayout.BeginHorizontal();
                if (GUILayout.Button(completed ? "Close" : "Cancel", GUILayout.Width(100))) Close();
                GUILayout.FlexibleSpace();
                if (completed)
                {
                    if (GUILayout.Button("Open Importer", GUILayout.Width(180))) { DevcelImporterWindow.Open(); Close(); }
                }
                else
                {
                    using (new EditorGUI.DisabledScope(step == Step.Source))
                        if (GUILayout.Button("Back", GUILayout.Width(90))) { step--; status = null; scroll = Vector2.zero; }
                    using (new EditorGUI.DisabledScope(!ready))
                    {
                        if (step == Step.Review)
                        {
                            if (GUILayout.Button("Save and Import", GUILayout.Width(180)) && Event.current.clickCount < 2) Queue(RegisterAndExport);
                        }
                        else if (GUILayout.Button("Next", GUILayout.Width(120)) && Event.current.clickCount < 2) { step++; status = null; scroll = Vector2.zero; }
                    }
                }
                EditorGUILayout.EndHorizontal();
            }
            EditorGUILayout.Space();
        }
    }
}
