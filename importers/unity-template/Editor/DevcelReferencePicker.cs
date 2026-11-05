using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>A searchable ID picker. Native handles are closed before any selection callback.</summary>
    internal sealed class DevcelReferencePicker : EditorWindow
    {
        internal sealed class Choice { public string Id; public string Label; public string TableUuid; public string Secondary; public int RowNumber; }
        private Choice[] choices = Array.Empty<Choice>();
        private string search = string.Empty, error;
        private Action<string> selected;
        private Vector2 scroll;
        private int page;
        private const int PageSize = 50;

        internal static Choice[] LoadChoices(DevcelProjectConfig project, string tableName, string expectedUuid = null)
        {
            using (var data = DevcelPreviewData.Open(Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName)))
            {
                int table = Array.FindIndex(data.Tables, value => value.name == tableName && (expectedUuid == null || value.uuid == expectedUuid));
                if (table < 0) throw new InvalidDataException("Reference target table not found: " + tableName);
                var result = new List<Choice>();
                var records = data.Tables[table].records;
                var labels = LabelsFor(project, data.Tables[table].uuid);
                for (int i = 0; i < records.Length; i++)
                    if (data.RowById(table, records[i].id) >= 0)
                        result.Add(new Choice { Id = records[i].id, Label = labels.TryGetValue(records[i].id, out string authored) && !string.IsNullOrEmpty(authored) ? authored : "Row " + (i + 1), RowNumber = i + 1, Secondary = DisplayData(data, table, i) });
                return result.ToArray();
            }
        }

        internal static Choice[] LoadInterfaceChoices(DevcelProjectConfig project, string requiredInterface, DevcelImplementingTableAttribute[] allowed)
        {
            using (var data = DevcelPreviewData.Open(Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName)))
            {
                var result = new List<Choice>();
                foreach (var implementation in allowed)
                {
                    int table = Array.FindIndex(data.Tables, value => value.uuid == implementation.TableUuid && value.name == implementation.TableName && Array.IndexOf(value.interfaces ?? Array.Empty<string>(), requiredInterface) >= 0);
                    if (table < 0) continue;
                    var labels = new Dictionary<string, string>();
                    foreach (DevcelRecordLabelAttribute item in implementation.ReferenceType.GetCustomAttributes(typeof(DevcelRecordLabelAttribute), false)) labels[item.Uuid] = item.Label;
                    for (int index = 0; index < data.Tables[table].records.Length; index++)
                    {
                        var record = data.Tables[table].records[index];
                        int row = data.RowById(table, record.id);
                        if (row < 0) continue;
                        int rowNumber = index + 1;
                        string label = labels.TryGetValue(record.id, out var authored) && !string.IsNullOrEmpty(authored) ? authored : "Row " + rowNumber;
                        result.Add(new Choice { Id = implementation.TableUuid + "/" + record.id, TableUuid = implementation.TableUuid, Label = implementation.TableName + " / " + label, RowNumber = rowNumber, Secondary = DisplayData(data, table, row) });
                    }
                }
                return result.ToArray();
            }
        }

        private static Dictionary<string, string> LabelsFor(DevcelProjectConfig project, string tableUuid)
        {
            var labels = new Dictionary<string, string>();
            Type match = null;
            foreach (var type in TypeCache.GetTypesDerivedFrom<DevcelTypedRecordReference>()) {
                var target = (DevcelRecordTargetAttribute)Attribute.GetCustomAttribute(type, typeof(DevcelRecordTargetAttribute));
                if (target == null || target.TableUuid != tableUuid || target.DatabaseType.FullName != project.GetNamespace() + "." + project.GetClassName()) continue;
                if (match != null) return labels; // Ambiguous generated metadata must not choose an arbitrary source.
                match = type;
            }
            if (match != null)
                foreach (DevcelRecordLabelAttribute item in match.GetCustomAttributes(typeof(DevcelRecordLabelAttribute), false)) labels[item.Uuid] = item.Label;
            return labels;
        }

        internal static bool Matches(Choice choice, string query) =>
            choice.Label.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
            choice.Id.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
            (choice.Secondary ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;

        private static string DisplayData(DevcelPreviewData data, int table, int row)
        {
            // Only explicit display-like columns, never an arbitrary first string field.
            var columns = data.Tables[table].columns;
            for (int i = 0; i < columns.Length; i++)
                if (columns[i].data_type == "String" && (columns[i].name == "display_name" || columns[i].name == "name" || columns[i].name == "title")) {
                    string value = data.Read(table, row, i);
                    if (!string.IsNullOrEmpty(value)) return columns[i].name + ": " + value;
                }
            return null;
        }

        internal static void Disambiguate(Choice[] items)
        {
            var counts = new Dictionary<string, int>();
            foreach (var item in items) counts[item.Label] = counts.TryGetValue(item.Label, out int n) ? n + 1 : 1;
            foreach (var item in items) if (counts[item.Label] > 1) {
                item.Label += " — " + (string.IsNullOrEmpty(item.Secondary) ? "Row " + item.RowNumber : item.Secondary);
            }
            counts.Clear();
            foreach (var item in items) counts[item.Label] = counts.TryGetValue(item.Label, out int n) ? n + 1 : 1;
            foreach (var item in items) if (counts[item.Label] > 1) item.Label += " (Row " + item.RowNumber + ")";
        }

        internal static void ShowActions(Action<string> clear, bool canClear)
        {
            var menu = new GenericMenu();
            if (canClear) menu.AddItem(new GUIContent("Clear"), false, () => clear(string.Empty));
            else menu.AddDisabledItem(new GUIContent("Clear"));
            menu.ShowAsContext();
        }

        public static void Open(DevcelProjectConfig project, string table, Action<string> selected)
        {
            var window = GetWindow<DevcelReferencePicker>(true, "Devcel Reference");
            window.selected = selected; window.error = null; window.search = string.Empty; window.page = 0;
            window.minSize = new Vector2(380, 280);
            try { window.choices = LoadChoices(project, table); Disambiguate(window.choices); }
            catch (Exception ex) { window.choices = Array.Empty<Choice>(); window.error = ex.Message; }
            window.Show();
        }

        internal static void OpenChoices(Choice[] source, IReadOnlyDictionary<string, string> labels, Action<string> selected, string table)
        {
            var window = GetWindow<DevcelReferencePicker>(true, "Devcel Reference");
            window.selected = selected; window.error = null; window.search = string.Empty; window.page = 0;
            window.minSize = new Vector2(380, 280);
            window.choices = Array.ConvertAll(source, item => new Choice {
                Id = item.Id, TableUuid = item.TableUuid, RowNumber = item.RowNumber, Secondary = item.Secondary, Label = labels.TryGetValue(item.Id, out string label) && !string.IsNullOrEmpty(label) ? label : item.Label
            });
            Disambiguate(window.choices);
            window.titleContent = new GUIContent("Select " + table);
            window.Show();
        }

        private void OnDisable() { selected = null; }
        private void Choose(string id) { var callback = selected; Close(); callback?.Invoke(id); }
        private void OnGUI()
        {
            if (error != null) EditorGUILayout.HelpBox((string)DevcelRecordPreview.Format(error), MessageType.Error);
            EditorGUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            if (GUILayout.Button(new GUIContent("...", "Reference actions"), GUILayout.Width(22))) ShowActions(Choose, selected != null);
            EditorGUILayout.EndHorizontal();
            string query = EditorGUILayout.TextField("Search", search);
            if (query != search) { search = query; page = 0; }
            int matched = 0;
            scroll = EditorGUILayout.BeginScrollView(scroll);
            foreach (var choice in choices)
            {
                if (!Matches(choice, search)) continue;
                int position = matched++;
                if (position < page * PageSize || position >= (page + 1) * PageSize) continue;
                if (GUILayout.Button(new GUIContent(choice.Label, choice.Label))) { Choose(choice.Id); break; }

            }
            EditorGUILayout.EndScrollView();
            int pages = Math.Max(1, (matched + PageSize - 1) / PageSize);
            EditorGUILayout.BeginHorizontal();
            using (new EditorGUI.DisabledScope(page == 0)) if (GUILayout.Button("Previous")) page--;
            EditorGUILayout.LabelField($"{page + 1} / {pages} ({matched} records)");
            using (new EditorGUI.DisabledScope(page + 1 >= pages)) if (GUILayout.Button("Next")) page++;
            EditorGUILayout.EndHorizontal();
        }
    }
}
