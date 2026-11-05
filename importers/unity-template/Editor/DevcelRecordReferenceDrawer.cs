using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    [CustomPropertyDrawer(typeof(DevcelRecordReference))]
    public sealed class DevcelRecordReferenceDrawer : PropertyDrawer
    {
        public override float GetPropertyHeight(SerializedProperty property, GUIContent label) =>
            (EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing) * 4;

        internal static GUIContent SafeFieldLabel(SerializedProperty property, GUIContent label)
        {
            string path = property.propertyPath;
            int start = path.LastIndexOf(".Array.data[", StringComparison.Ordinal);
            if (start >= 0 && path.EndsWith("]", StringComparison.Ordinal))
                return new GUIContent("Element " + path.Substring(start + 12, path.Length - start - 13));
            return new GUIContent((string)DevcelRecordPreview.Format(label.text), (string)DevcelRecordPreview.Format(label.tooltip ?? ""));
        }

        public override void OnGUI(Rect position, SerializedProperty property, GUIContent label)
        {
            EditorGUI.BeginProperty(position, label, property);
            try
            {
                var project = property.FindPropertyRelative("projectName");
                var table = property.FindPropertyRelative("tableName");
                var uuid = property.FindPropertyRelative("uuid");
                var targets = property.serializedObject.targetObjects;
                string path = property.propertyPath;
                var line = new Rect(position.x, position.y, position.width, EditorGUIUtility.singleLineHeight);
                EditorGUI.LabelField(line, SafeFieldLabel(property, label));
                line.y += EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing;
                if (EditorGUI.DropdownButton(line, new GUIContent("Project: " + project.stringValue), FocusType.Keyboard))
                {
                    var menu = new GenericMenu();
                    foreach (var candidate in DevcelImporterSettings.Instance.projects)
                    {
                        string name = candidate.projectName;
                        menu.AddItem(new GUIContent(name), name == project.stringValue, () => Apply(targets, path, value => {
                            if (!value.FindPropertyRelative("projectName").hasMultipleDifferentValues && value.FindPropertyRelative("projectName").stringValue == name) return;
                            value.FindPropertyRelative("projectName").stringValue = name;
                            value.FindPropertyRelative("tableName").stringValue = string.Empty;
                            value.FindPropertyRelative("uuid").stringValue = string.Empty;
                        }));
                    }
                    if (DevcelImporterSettings.Instance.projects.Count == 0) menu.AddDisabledItem(new GUIContent("Add a project in the Importer"));
                    menu.ShowAsContext();
                }
                line.y += EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing;
                if (EditorGUI.DropdownButton(line, new GUIContent("Table: " + table.stringValue), FocusType.Keyboard))
                    ShowTables(targets, path, project.stringValue, table.stringValue);
                line.y += EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing;
                var config = FindProject(project.stringValue);
                var catalog = config == null || string.IsNullOrEmpty(table.stringValue) ? null : DevcelReferenceCatalog.Get(config, table.stringValue);
                bool mixed = uuid.hasMultipleDifferentValues || project.hasMultipleDifferentValues || table.hasMultipleDifferentValues;
                var choice = catalog?.Choices == null ? null : Array.Find(catalog.Choices, item => item.Id == uuid.stringValue);
                string caption = mixed ? "Multiple values" : string.IsNullOrEmpty(uuid.stringValue) ? "None" : choice?.Label ?? (catalog?.Choices == null ? "Reference unavailable" : "Missing record");
                var actions = new Rect(line.xMax - 22, line.y, 22, line.height);
                line.width = Mathf.Max(0, line.width - 26);
                using (new EditorGUI.DisabledScope(config == null || catalog?.Choices == null))
                    if (GUI.Button(line, new GUIContent(caption, caption), EditorStyles.popup)) {
                        var apply = DevcelTypedRecordReferenceDrawer.CaptureAssignment(property);
                        DevcelReferencePicker.OpenChoices(catalog.Choices, new System.Collections.Generic.Dictionary<string,string>(), apply, table.stringValue);
                    }
                if (GUI.Button(actions, new GUIContent("...", "Reference actions")))
                    DevcelReferencePicker.ShowActions(DevcelTypedRecordReferenceDrawer.CaptureAssignment(property), mixed || !string.IsNullOrEmpty(uuid.stringValue));
            }
            finally { EditorGUI.EndProperty(); }
        }

        internal static DevcelProjectConfig FindProject(string name)
        {
            DevcelProjectConfig found = null;
            foreach (var project in DevcelImporterSettings.Instance.projects)
            {
                if (project == null || project.projectName != name) continue;
                if (found != null) return null; // A malformed duplicate setting must not choose an arbitrary bundle.
                found = project;
            }
            return found;
        }

        private static void Apply(UnityEngine.Object[] targets, string path, Action<SerializedProperty> change)
        {
            // The menu callback can run after the original SerializedProperty is invalidated.
            // Reacquire it and let Unity record Undo/prefab overrides for the component only.
            if (targets == null || targets.Length == 0 || targets[0] == null) return;
            var serialized = new SerializedObject(targets);
            serialized.Update();
            var property = serialized.FindProperty(path);
            if (property == null) return;
            change(property);
            serialized.ApplyModifiedProperties();
        }

        private static void ShowTables(UnityEngine.Object[] targets, string path, string project, string current)
        {
            var config = FindProject(project);
            if (config == null) { DevcelImporterSettings.LogWarning("Select the project for the reference first."); return; }
            try
            {
                var menu = new GenericMenu();
                using (var data = DevcelPreviewData.Open(Path.Combine(DevcelPaths.ToAbsolute(config.GetJsonOutputFolder()), config.bundleFileName)))
                {
                    foreach (var table in data.Tables)
                    {
                        string name = table.name;
                        menu.AddItem(new GUIContent(name), name == current, () => Apply(targets, path, value => {
                            if (!value.FindPropertyRelative("tableName").hasMultipleDifferentValues && value.FindPropertyRelative("tableName").stringValue == name) return;
                            value.FindPropertyRelative("tableName").stringValue = name;
                            value.FindPropertyRelative("uuid").stringValue = string.Empty;
                        }));
                    }
                    if (data.Tables.Length == 0) menu.AddDisabledItem(new GUIContent("No tables available"));
                }
                menu.ShowAsContext();
            }
            catch (Exception ex) { DevcelImporterSettings.LogError("Cannot load the reference list: " + ex.Message); }
        }
    }
}
