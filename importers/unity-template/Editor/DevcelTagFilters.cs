using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    // Discovery never changes saved selections, including unregistered names after a merge.
    internal static class DevcelTagFilters
    {
        [Serializable] private class Data { public string[] presets; }
        [Serializable] private class Envelope { public bool ok; public Data data; }
        private static string loadedProject;
        private static string[] presets = new string[0];
        private static string error;
        internal static void Draw(DevcelProjectConfig source)
        {
            EditorGUILayout.LabelField("Tag filters (this source only)", EditorStyles.boldLabel);
            if (loadedProject != source.devcelProjectPath || GUILayout.Button("Refresh project tag presets"))
            {
                loadedProject = source.devcelProjectPath;
                presets = new string[0];
                try
                {
                    var result = DevcelCliRunner.Run("tag-presets --mode local --project " + DevcelCliRunner.QuoteArgument(DevcelPaths.ResolveFromProjectRoot(loadedProject)), timeoutMs: 5000);
                    var envelope = result.Ok ? JsonUtility.FromJson<Envelope>(result.Stdout) : null;
                    if (envelope?.data?.presets == null) error = result.Error ?? "Cannot read project tag presets.";
                    else { presets = envelope.data.presets; error = null; }
                }
                catch (Exception ex) { error = ex.Message; }
            }
            if (error != null) EditorGUILayout.HelpBox(error + " Existing filters are retained.", MessageType.Warning);
            EditorGUILayout.HelpBox("Empty includes select all. Includes match any selected tag; excludes win. Unknown names remain editable until repaired to a project preset.", MessageType.Info);
            DrawList("Row include tags", source.row_include_tags);
            DrawList("Row exclude tags", source.row_exclude_tags);
            DrawList("Column include tags", source.column_include_tags);
            DrawList("Column exclude tags", source.column_exclude_tags);
        }
        private static void DrawList(string label, List<string> tags)
        {
            EditorGUILayout.LabelField(label);
            if (tags == null) { EditorGUILayout.HelpBox("Invalid null filter array. Repair settings before importing.", MessageType.Error); return; }
            for (int i = 0; i < tags.Count; i++)
            {
                EditorGUILayout.BeginHorizontal();
                tags[i] = EditorGUILayout.TextField(tags[i]);
                if (GUILayout.Button("Remove", GUILayout.Width(70))) { tags.RemoveAt(i); i--; }
                EditorGUILayout.EndHorizontal();
                if (i >= 0 && i < tags.Count && Array.IndexOf(presets, tags[i]) < 0)
                    EditorGUILayout.HelpBox("Unregistered tag: " + tags[i] + ". Edit it to a project preset or explicitly remove it.", MessageType.Warning);
            }
            var options = new string[presets.Length + 1]; options[0] = "Add project preset…";
            Array.Copy(presets, 0, options, 1, presets.Length);
            int picked = EditorGUILayout.Popup(0, options);
            if (picked > 0 && !tags.Contains(presets[picked - 1])) tags.Add(presets[picked - 1]);
        }
    }
}
