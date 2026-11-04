using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>Read-only snapshot of generated, resolved values. No authoring writes or retained native owner.</summary>
    internal sealed class DevcelRecordPreview : EditorWindow
    {
        internal sealed class Cell { public string Name; public string Value; }
        [Serializable] private sealed class Metadata { public DevcelPreviewData.Table[] tables; }
        private DevcelProjectConfig project;
        private Type referenceType, databaseType;
        private string uuid, tableUuid, caption, error;
        private Cell[] cells = Array.Empty<Cell>();
        private Vector2 scroll;
        private long stamp = -1, length = -1;
        private double nextCheck;
        private bool pending;
        private readonly HashSet<string> expanded = new HashSet<string>();
        private static readonly Regex Identifiers = new Regex(@"\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b");

        internal static void Open(DevcelProjectConfig project, Type database, Type reference, string uuid, string tableUuid, string caption)
        {
            var window = GetWindow<DevcelRecordPreview>(true, "Record preview");
            window.project = project; window.databaseType = database; window.referenceType = reference;
            window.uuid = uuid; window.tableUuid = tableUuid; window.caption = caption;
            window.cells = Array.Empty<Cell>(); window.expanded.Clear(); window.error = null; window.stamp = -1; window.nextCheck = 0;
            window.minSize = new Vector2(360, 260); window.QueueRefresh(); window.Show();
        }

        internal static Cell[] Read(DevcelProjectConfig config, Type database, Type reference, string id, string table)
        {
            string path = Path.Combine(DevcelPaths.ToAbsolute(config.GetJsonOutputFolder()), config.bundleFileName);
            string json = File.ReadAllText(path);
            object key = table == null ? Activator.CreateInstance(reference, id) : Activator.CreateInstance(reference, table, id);
            var method = database.GetMethod("Get", new[] { reference });
            if (method == null) throw new InvalidDataException("Generated typed Get is unavailable. Regenerate this database.");
            using (var owner = (IDisposable)database.GetMethod("FromJson", new[] { typeof(string) }).Invoke(null, new object[] { json }))
            {
                object record = method.Invoke(owner, new[] { key });
                if (record == null) throw new InvalidDataException("Missing record. The saved reference is unchanged.");
                var result = new List<Cell>();
                var metadata = JsonUtility.FromJson<Metadata>(json);
                foreach (var property in method.ReturnType.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                {
                    if (!property.CanRead || property.GetIndexParameters().Length != 0 || property.Name == "Uuid" || property.Name == "TableUuid" || property.Name == "Exists") continue;
                    // Display reference summaries, not the serialized identifier-bearing companion string.
                    if (IsTableReferenceCompanion(property, method.ReturnType, database)) continue;
                    result.Add(new Cell { Name = ObjectNames.NicifyVariableName(property.Name), Value = DescribeReference(property.GetValue(record), database, metadata.tables) });
                }
                return result.ToArray();
            }
        }

        internal static bool IsTableReferenceCompanion(PropertyInfo property, Type record, Type database)
        {
            Type helper = database.Assembly.GetType(database.Namespace + ".DevcelTableHandle");
            return helper != null && property.PropertyType == typeof(string) && record.GetProperty(property.Name + "Table")?.PropertyType == helper;
        }

        private static string DescribeReference(object value, Type database, DevcelPreviewData.Table[] tables)
        {
            if (value == null) return "None";
            Type type = value.GetType();
            bool isTable = type == database.Assembly.GetType(database.Namespace + ".DevcelTableHandle");
            var idProperty = type.GetProperty("Uuid");
            var tableProperty = type.GetProperty("TableUuid");
            if (idProperty == null || (!isTable && tableProperty == null) || type.GetProperty("Exists") == null) return Format(value);
            string id = (string)idProperty.GetValue(value);
            string tableId = isTable ? id : (string)tableProperty.GetValue(value);
            var table = Array.Find(tables, item => item.uuid == tableId);
            string tableName = table?.name;
            string label = null;
            foreach (var reference in TypeCache.GetTypesDerivedFrom<DevcelTypedRecordReference>()) {
                var target = reference.GetCustomAttribute<DevcelRecordTargetAttribute>();
                if (target == null || target.DatabaseType != database || target.TableUuid != tableId) continue;
                tableName = tableName ?? target.TableName;
                label = reference.GetCustomAttributes<DevcelRecordLabelAttribute>().FirstOrDefault(item => item.Uuid == id)?.Label;
                break;
            }
            bool exists = (bool)type.GetProperty("Exists").GetValue(value);
            if (!exists) return (isTable ? "Missing table" : "Missing record") + (string.IsNullOrEmpty(tableName) ? "" : " / " + tableName) + (isTable || string.IsNullOrEmpty(label) ? "" : " / " + label);
            if (isTable) return (tableName ?? "Table") + " (" + type.GetProperty("Count").GetValue(value) + " records)";
            int row = table == null ? -1 : Array.FindIndex(table.records, item => item.id == id);
            return (tableName ?? "Table") + " / " + (!string.IsNullOrEmpty(label) ? label : row >= 0 ? "Row " + (row + 1) : "Record");
        }

        private string CurrentCaption()
        {
            var target = referenceType.GetCustomAttribute<DevcelRecordTargetAttribute>();
            var contract = referenceType.GetCustomAttribute<DevcelInterfaceTargetAttribute>();
            var choices = target != null
                ? DevcelReferencePicker.LoadChoices(project, target.TableName, target.TableUuid)
                : DevcelReferencePicker.LoadInterfaceChoices(project, contract.InterfaceUuid, referenceType.GetCustomAttributes<DevcelImplementingTableAttribute>().ToArray());
            string key = target != null ? uuid : tableUuid + "/" + uuid;
            return Array.Find(choices, item => item.Id == key)?.Label ?? "Missing record";
        }

        internal static string Format(object value)
        {
            if (value == null) return "None";
            if (value is string text) return Identifiers.Replace(text, "[identifier]");
            var type = value.GetType();
            if (type.GetProperty("Uuid") != null) {
                bool missing = type.GetProperty("Exists")?.GetValue(value) is bool exists && !exists;
                return missing ? "Missing reference" : "Reference";
            }
            if (value is bool flag) return flag ? "True" : "False";
            if (value is IFormattable scalar) return scalar.ToString(null, CultureInfo.InvariantCulture);
            var channels = new List<string>();
            foreach (string name in new[] { "R", "G", "B", "A" }) {
                var field = type.GetField(name);
                if (field != null) channels.Add(name + ": " + Convert.ToString(field.GetValue(value), CultureInfo.InvariantCulture));
            }
            return channels.Count == 4 ? string.Join("  ", channels) : type.Name;
        }

        private void Update()
        {
            if (project == null || pending || EditorApplication.timeSinceStartup < nextCheck) return;
            nextCheck = EditorApplication.timeSinceStartup + 1;
            try {
                var info = new FileInfo(Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName));
                if (info.LastWriteTimeUtc.Ticks != stamp || info.Length != length) QueueRefresh();
            } catch (Exception ex) { cells = Array.Empty<Cell>(); error = ex.Message; Repaint(); }
        }

        private void QueueRefresh()
        {
            if (pending) return;
            pending = true;
            EditorApplication.delayCall += () => {
                if (this == null) return;
                try {
                    string path = Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName);
                    var before = new FileInfo(path); long startStamp = before.LastWriteTimeUtc.Ticks, startLength = before.Length;
                    var fresh = Read(project, databaseType, referenceType, uuid, tableUuid);
                    var after = new FileInfo(path);
                    if (after.LastWriteTimeUtc.Ticks != startStamp || after.Length != startLength) throw new IOException("Imported data changed during preview; refresh again.");
                    cells = fresh; caption = CurrentCaption(); error = null; stamp = startStamp; length = startLength;
                } catch (Exception ex) { cells = Array.Empty<Cell>(); error = (ex.InnerException ?? ex).Message; }
                finally { pending = false; Repaint(); }
            };
        }

        internal static bool UsesMultiline(string value, float measuredWidth, float availableWidth)
            => value.IndexOfAny(new[] { '\r', '\n' }) >= 0 || measuredWidth > availableWidth;

        internal static GUIStyle ValueStyle(bool multiline, GUIStyle basis)
            => new GUIStyle(basis) {
                alignment = TextAnchor.UpperRight,
                wordWrap = multiline,
                clipping = TextClipping.Clip
            };

        private void OnGUI()
        {
            EditorGUILayout.BeginVertical(new GUIStyle { padding = new RectOffset(10, 10, 8, 10) });
            EditorGUILayout.LabelField(caption ?? "Record", EditorStyles.boldLabel);
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Read-only / resolved values", EditorStyles.miniLabel);
            if (GUILayout.Button("Refresh", GUILayout.Width(64))) QueueRefresh();
            EditorGUILayout.EndHorizontal();
            if (pending) EditorGUILayout.LabelField("Loading...");
            if (error != null) EditorGUILayout.HelpBox(Identifiers.Replace(error, "[identifier]"), MessageType.Warning);
            scroll = EditorGUILayout.BeginScrollView(scroll);
            float available = Mathf.Max(200, position.width - 52);
            float labelWidth = Mathf.Clamp(available * 0.35f, 90, 170);
            float valueWidth = available - labelWidth - 12;
            foreach (var cell in cells) {
                var content = new GUIContent(cell.Value);
                bool multiline = UsesMultiline(cell.Value, EditorStyles.label.CalcSize(content).x, valueWidth);
                var valueStyle = ValueStyle(multiline, EditorStyles.label);
                float height = Mathf.Max(EditorGUIUtility.singleLineHeight, valueStyle.CalcHeight(content, valueWidth));
                bool full = expanded.Contains(cell.Name);
                float shownHeight = full ? height : Mathf.Min(height, 160);
                Rect row = EditorGUILayout.GetControlRect(false, shownHeight);
                Rect labelRect = new Rect(row.x, row.y, labelWidth, row.height);
                Rect valueRect = new Rect(labelRect.xMax + 12, row.y, Mathf.Max(1, row.width - labelWidth - 12), row.height);
                var labelStyle = ValueStyle(false, EditorStyles.label);
                labelStyle.alignment = TextAnchor.UpperLeft;
                labelStyle.fontStyle = FontStyle.Bold;
                EditorGUI.LabelField(labelRect, new GUIContent(cell.Name, cell.Name), labelStyle);
                EditorGUI.SelectableLabel(valueRect, cell.Value, valueStyle);
                if (height > 160) {
                    EditorGUILayout.BeginHorizontal();
                    GUILayout.Space(labelWidth + 12);
                    if (GUILayout.Button(full ? "Show less" : "Show full value", GUILayout.Width(120))) {
                        if (full) expanded.Remove(cell.Name); else expanded.Add(cell.Name);
                    }
                    EditorGUILayout.EndHorizontal();
                }
                GUILayout.Space(4);
            }
            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();
        }
    }
}
