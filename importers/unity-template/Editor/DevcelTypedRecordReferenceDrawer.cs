using System;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    [CustomPropertyDrawer(typeof(DevcelTypedRecordReference), true)]
    public sealed class DevcelTypedRecordReferenceDrawer : PropertyDrawer
    {
        public override float GetPropertyHeight(SerializedProperty property, GUIContent label) =>
            2 * (EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing);

        internal static Type ElementType(Type type)
        {
            if (type.IsArray) return type.GetElementType();
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>)) return type.GetGenericArguments()[0];
            return type;
        }

        internal static DevcelProjectConfig FindProject(Type database, out string error)
        {
            error = null;
            DevcelProjectConfig match = null;
            foreach (var config in DevcelImporterSettings.Instance.projects)
            {
                if (config == null || config.GetNamespace() + "." + config.GetClassName() != database.FullName) continue;
                if (match != null) { error = "Multiple importer sources generate this database type. Use a unique namespace/class per source."; return null; }
                match = config;
            }
            if (match == null) error = "Register and import the source for " + database.FullName;
            return match;
        }

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
                var type = ElementType(fieldInfo.FieldType);
                var target = type.GetCustomAttribute<DevcelRecordTargetAttribute>();
                var interfaceTarget = type.GetCustomAttribute<DevcelInterfaceTargetAttribute>();
                var tableUuid = property.FindPropertyRelative("tableUuid");
                var uuid = property.FindPropertyRelative("uuid");
                if ((target == null && interfaceTarget == null) || uuid == null) { EditorGUI.LabelField(position, label.text, "Invalid generated reference metadata"); return; }
                var databaseType = target?.DatabaseType ?? interfaceTarget.DatabaseType;
                string targetName = target?.TableName ?? type.Name;
                var config = FindProject(databaseType, out string error);
                var catalog = config == null ? null : DevcelReferenceCatalog.Get(config, targetName, interfaceTarget, type.GetCustomAttributes<DevcelImplementingTableAttribute>().ToArray(), target?.TableUuid);
                var labels = new Dictionary<string, string>();
                foreach (var item in type.GetCustomAttributes<DevcelRecordLabelAttribute>()) labels[item.Uuid] = item.Label;
                string id = interfaceTarget != null && !string.IsNullOrEmpty(uuid.stringValue) ? tableUuid.stringValue + "/" + uuid.stringValue : uuid.stringValue;
                bool mixed = uuid.hasMultipleDifferentValues || (tableUuid?.hasMultipleDifferentValues ?? false);
                string name = mixed ? "Multiple values" : string.IsNullOrEmpty(id) ? "None" : labels.TryGetValue(id, out string known) ? known : "Reference unavailable";
                bool missing = false;
                if (!mixed && !string.IsNullOrEmpty(id) && catalog?.Choices != null)
                {
                    var choice = Array.Find(catalog.Choices, item => item.Id == id);
                    missing = choice == null;
                    name = missing ? (labels.TryGetValue(id, out string oldLabel) ? "Missing record: " + oldLabel : "Missing record") : labels.TryGetValue(id, out string authored) ? authored : choice.Label;
                }
                var line = new Rect(position.x, position.y, position.width, EditorGUIUtility.singleLineHeight);
                var field = EditorGUI.PrefixLabel(line, SafeFieldLabel(property, label));
                var actions = new Rect(field.xMax - 22, field.y, 22, field.height);
                field.width = Mathf.Max(0, field.width - 26);
                using (new EditorGUI.DisabledScope(config == null || catalog?.Choices == null))
                {
                    if (GUI.Button(field, new GUIContent(name, name), EditorStyles.popup))
                    {
                        var apply = CaptureAssignment(property);
                        DevcelReferencePicker.OpenChoices(catalog.Choices, labels, apply, targetName);
                    }
                }
                if (GUI.Button(actions, new GUIContent("...", "Reference actions")))
                    DevcelReferencePicker.ShowActions(CaptureAssignment(property), mixed || !string.IsNullOrEmpty(id));
                line.y += EditorGUIUtility.singleLineHeight + EditorGUIUtility.standardVerticalSpacing;
                string status = error ?? catalog?.Error ?? (catalog?.Choices == null ? "Loading imported records…" :
                    missing ? "Missing record. Saved reference retained." :
                    databaseType.Name + " / " + targetName + (mixed ? " — mixed selection" : ""));
                var preview = new Rect(line.xMax - 44, line.y, 44, line.height);
                line.width = Mathf.Max(0, line.width - 48);
                using (new EditorGUI.DisabledScope(mixed || string.IsNullOrEmpty(id) || config == null))
                    if (GUI.Button(preview, "View")) DevcelRecordPreview.Open(config, databaseType, type, uuid.stringValue, interfaceTarget == null ? null : tableUuid.stringValue, name);
                EditorGUI.LabelField(line, new GUIContent((string)DevcelRecordPreview.Format(status), (string)DevcelRecordPreview.Format(status)), missing || error != null || catalog?.Error != null ? EditorStyles.boldLabel : EditorStyles.miniLabel);
            }
            finally { EditorGUI.EndProperty(); }
        }

        // Reject stale callbacks rather than changing a different array element after a reorder.
        internal static Action<string> CaptureAssignment(SerializedProperty property)
        {
            var targets = property.serializedObject.targetObjects;
            var snapshots = new string[targets.Length];
            string path = property.propertyPath;
            for (int i = 0; i < targets.Length; i++) snapshots[i] = EditorJsonUtility.ToJson(targets[i]);
            return id =>
            {
                for (int i = 0; i < targets.Length; i++)
                {
                    if (targets[i] == null || EditorJsonUtility.ToJson(targets[i]) != snapshots[i])
                    { Debug.LogWarning("Devcel selection cancelled: the inspected objects changed while the picker was open. Reopen the picker."); return; }
                    using (var check = new SerializedObject(targets[i]))
                        if (check.FindProperty(path)?.FindPropertyRelative("uuid") == null) return;
                }
                using (var serialized = new SerializedObject(targets))
                {
                    serialized.Update();
                    var field = serialized.FindProperty(path)?.FindPropertyRelative("uuid");
                    if (field == null) return;
                    var table = serialized.FindProperty(path)?.FindPropertyRelative("tableUuid");
                    if (table != null)
                    {
                        int separator = id.IndexOf('/');
                        if (id.Length != 0 && separator < 0) return;
                        table.stringValue = separator < 0 ? string.Empty : id.Substring(0, separator);
                        field.stringValue = separator < 0 ? string.Empty : id.Substring(separator + 1);
                    }
                    else field.stringValue = id;
                    serialized.ApplyModifiedProperties();
                }
            };
        }
    }
}
