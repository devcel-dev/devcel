using System;
using System.IO;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>Read-only native runtime preview, usable without entering Play mode.</summary>
    public sealed class DevcelPreviewWindow : EditorWindow
    {
        private DevcelProjectConfig project;
        private DevcelPreviewData data;
        private string error, search = string.Empty;
        private int table, page;
        private Vector2 scroll;
        private const int PageSize = 25;
        private readonly List<int> filtered = new List<int>();
        private bool filterDirty = true;

        public static void Open(DevcelProjectConfig project)
        {
            var window = GetWindow<DevcelPreviewWindow>("Devcel Preview");
            window.project = project;
            window.minSize = new Vector2(440, 320);
            window.Reload();
            window.Show();
        }

        private void OnEnable() { AssemblyReloadEvents.beforeAssemblyReload += DisposeData; }
        private void OnDisable() { AssemblyReloadEvents.beforeAssemblyReload -= DisposeData; DisposeData(); }
        private void DisposeData() { data?.Dispose(); data = null; }
        private void Reload()
        {
            DisposeData(); error = null; table = 0; page = 0; filterDirty = true;
            if (project == null) return;
            try { data = DevcelPreviewData.Open(Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName)); }
            catch (Exception ex) { error = ex.Message + "\nCheck the CLI export and placement of the Editor devcel_runtime library."; }
        }

        private void OnGUI()
        {
            if (project == null) { EditorGUILayout.HelpBox("Open the preview from a project in the Importer.", MessageType.Info); return; }
            EditorGUILayout.LabelField(project.projectName + " — Read-only", EditorStyles.boldLabel);
            if (GUILayout.Button("Reload Bundle")) Reload();
            if (error != null) { EditorGUILayout.HelpBox(error, MessageType.Error); return; }
            if (data == null || data.Tables.Length == 0) { EditorGUILayout.HelpBox("No tables are available.", MessageType.Info); return; }
            try
            {
                var names = Array.ConvertAll(data.Tables, value => value.name);
                int selection = EditorGUILayout.Popup("Table", table, names);
                if (selection != table) { table = selection; page = 0; filterDirty = true; }
                string query = EditorGUILayout.TextField("Search (UUID / value)", search);
                if (query != search) { search = query; page = 0; filterDirty = true; }
                int count = data.RowCount(table);
                EditorGUILayout.LabelField($"{count} records / {data.Tables[table].columns.Length} columns", EditorStyles.miniLabel);
                var rows = data.Tables[table].records;
                if (filterDirty)
                {
                    filtered.Clear();
                    for (int i = 0; i < rows.Length; i++)
                    {
                        bool match = string.IsNullOrEmpty(search) || rows[i].id.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
                        int row = data.RowById(table, rows[i].id);
                        if (row < 0) continue;
                        for (int c = 0; !match && c < data.Tables[table].columns.Length; c++)
                            match = data.Read(table, row, c).IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
                        if (match) filtered.Add(i);
                    }
                    filterDirty = false;
                }
                int matched = filtered.Count;
                int pages = Math.Max(1, (matched + PageSize - 1) / PageSize);
                scroll = EditorGUILayout.BeginScrollView(scroll);
                try
                {
                    for (int position = page * PageSize; position < Math.Min(matched, (page + 1) * PageSize); position++)
                    {
                        int i = filtered[position];
                        int row = data.RowById(table, rows[i].id);
                        EditorGUILayout.BeginVertical(EditorStyles.helpBox);
                        try
                        {
                            EditorGUILayout.LabelField(rows[i].id, EditorStyles.miniBoldLabel);
                            for (int c = 0; c < data.Tables[table].columns.Length; c++)
                                EditorGUILayout.LabelField(data.Tables[table].columns[c].name, data.Read(table, row, c));
                        }
                        finally { EditorGUILayout.EndVertical(); }
                    }
                }
                finally { EditorGUILayout.EndScrollView(); }
                page = Math.Min(page, pages - 1);
                EditorGUILayout.BeginHorizontal();
                using (new EditorGUI.DisabledScope(page == 0)) if (GUILayout.Button("Previous")) page--;
                EditorGUILayout.LabelField($"{page + 1} / {pages} ({matched} search results)");
                using (new EditorGUI.DisabledScope(page + 1 >= pages)) if (GUILayout.Button("Next")) page++;
                EditorGUILayout.EndHorizontal();
            }
            catch (Exception ex) { error = ex.Message; DisposeData(); }
        }
    }
}
