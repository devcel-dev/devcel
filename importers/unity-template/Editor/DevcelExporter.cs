using System;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Title-owned multi-source pull. Reads saved projects without Studio or P2P.</summary>
    public static class DevcelExporter
    {
        [Serializable] private class Envelope { public bool ok; public Report data; }
        [Serializable] private class Report { public SourceReport[] sources; }
        [Serializable] private class SourceReport
        {
            public string id;
            public string status;
            public string content_hash;
            public string pulled_at;
            public PullError error;
        }
        [Serializable] private class PullError { public string kind; public string text; public ErrorParams @params; }
        [Serializable] private class ErrorParams { public string details; }

        public static bool ExportAll(bool onlyAutoSync = false)
        {
            var settings = DevcelImporterSettings.Instance;
            bool ok = true;
            bool editing = false;
            try
            {
                // Whole configuration is checked before the first source can publish.
                WritePullConfig(settings);
                AssetDatabase.StartAssetEditing();
                editing = true;
                foreach (var project in settings.projects)
                {
                    if (onlyAutoSync && !project.autoSync) continue;
                    ok &= ExportProject(project, settings, refreshAssets: false);
                }
            }
            catch (Exception ex) { DevcelImporterSettings.LogError(ex.Message); return false; }
            finally { if (editing) AssetDatabase.StopAssetEditing(); AssetDatabase.Refresh(); }
            return ok;
        }

        public static bool ExportProject(DevcelProjectConfig project, DevcelImporterSettings settings, bool refreshAssets = true)
        {
            if (project == null) return false;
            try
            {
                string config = WritePullConfig(settings);
                string codePath = Path.Combine(DevcelPaths.ToAbsolute(project.GetCodeOutputFolder()), "Devcel.cs");
                string before = File.Exists(codePath) ? File.ReadAllText(codePath) : null;
                var result = DevcelCliRunner.Run("pull --config " + DevcelCliRunner.QuoteArgument(config) +
                    " --source " + DevcelCliRunner.QuoteArgument(project.projectName));
                ApplyReport(settings, result.Stdout);
                if (!result.Ok) throw new InvalidOperationException(result.Error);
                string bundle = Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName);
                if (!File.Exists(bundle) || !File.Exists(codePath)) throw new IOException("Generated output was not found after the CLI completed successfully.");
                DevcelReferenceCatalog.Invalidate();
                project.lastError = null;
                project.lastExport = DateTime.Now;
                project.lastExportCodeChanged = before == null || before != File.ReadAllText(codePath);
                DevcelPlayModeReload.NotifyExport(project, settings, bundle, project.lastExportCodeChanged);
                if (refreshAssets) AssetDatabase.Refresh();
                return true;
            }
            catch (Exception ex)
            {
                project.lastPullStatus = "error";
                project.lastError = ex.Message;
                DevcelImporterSettings.LogError(project.projectName + ": " + ex.Message);
                return false;
            }
        }

        public static void CheckStatus(DevcelImporterSettings settings)
        {
            try
            {
                var result = DevcelCliRunner.Run("pull --config " +
                    DevcelCliRunner.QuoteArgument(WritePullConfig(settings)) + " --status");
                ApplyReport(settings, result.Stdout);
                if (!result.Ok && string.IsNullOrEmpty(result.Stdout)) throw new InvalidOperationException(result.Error);
            }
            catch (Exception ex)
            {
                foreach (var project in settings.projects) if (project != null) { project.lastError = ex.Message; project.lastPullStatus = "error"; }
            }
        }

        private static void ApplyReport(DevcelImporterSettings settings, string json)
        {
            if (string.IsNullOrEmpty(json)) return;
            var envelope = JsonUtility.FromJson<Envelope>(json);
            if (envelope == null || envelope.data == null || envelope.data.sources == null)
                throw new InvalidOperationException(json); // Preserve complete structured global error.
            foreach (var source in envelope.data.sources)
            {
                var project = settings.projects.Find(item => item != null && item.projectName == source.id);
                if (project == null) continue;
                project.lastPullStatus = source.status;
                project.lastContentHash = source.content_hash;
                if (DateTime.TryParse(source.pulled_at, out DateTime timestamp)) project.lastExport = timestamp.ToLocalTime();
                project.lastError = source.status == "error"
                    ? (!string.IsNullOrEmpty(source.error?.text) ? source.error.text : source.error?.@params?.details ?? json)
                    : null;
            }
        }

        private static string WritePullConfig(DevcelImporterSettings settings)
        {
            if (settings.projects == null || settings.projects.Count == 0) throw new InvalidOperationException("Register a source project.");
            var text = new StringBuilder("{\"schema_version\":1,\"sources\":[");
            for (int index = 0; index < settings.projects.Count; index++)
            {
                var source = settings.projects[index];
                if (source == null) throw new InvalidOperationException("The source project settings are null.");
                if (!source.TryValidate(settings, out string validationError)) throw new InvalidOperationException(validationError);
                string project = DevcelPaths.ResolveFromProjectRoot(source.devcelProjectPath);
                if (Directory.Exists(project)) project = Directory.GetFiles(project, "*.devcelproj.toml")[0];
                if (index != 0) text.Append(',');
                text.Append("{\"id\":").Append(JsonString(source.projectName));
                text.Append(",\"project\":").Append(JsonString(project));
                text.Append(",\"namespace\":").Append(JsonString(source.GetNamespace()));
                if (!string.IsNullOrWhiteSpace(source.codeClassName))
                    text.Append(",\"class_name\":").Append(JsonString(source.GetClassName()));
                text.Append(",\"runtime_out\":").Append(JsonString(Path.Combine(DevcelPaths.ToAbsolute(source.GetJsonOutputFolder()), source.bundleFileName)));
                text.Append(",\"code_out\":").Append(JsonString(Path.Combine(DevcelPaths.ToAbsolute(source.GetCodeOutputFolder()), "Devcel.cs")));
                text.Append(",\"code_target\":\"csharp\",\"mode\":").Append(JsonString(source.minimal ? "minimal" : "full"));
                long? version = source.GetContentVersion(settings.activeEnvironment);
                if (version.HasValue) text.Append(",\"version\":").Append(version.Value);
                AppendTags(text, "row_include_tags", source.row_include_tags);
                AppendTags(text, "row_exclude_tags", source.row_exclude_tags);
                AppendTags(text, "column_include_tags", source.column_include_tags);
                AppendTags(text, "column_exclude_tags", source.column_exclude_tags);
                text.Append('}');
            }
            text.Append("]}");
            string directory = Path.Combine(DevcelPaths.ProjectRoot, "Library", "Devcel");
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "devcel.import.json");
            string data = text.ToString();
            if (!File.Exists(path) || File.ReadAllText(path) != data) File.WriteAllText(path, data, new UTF8Encoding(false));
            return path;
        }

        private static void AppendTags(StringBuilder text, string key, System.Collections.Generic.List<string> tags)
        {
            if (tags == null) throw new InvalidOperationException(key + " must be an array.");
            text.Append(',').Append(JsonString(key)).Append(":[");
            for (int i = 0; i < tags.Count; i++)
            {
                if (tags[i] == null) throw new InvalidOperationException(key + " contains null.");
                if (i != 0) text.Append(',');
                text.Append(JsonString(tags[i]));
            }
            text.Append(']');
        }

        private static string JsonString(string value)
        {
            var text = new StringBuilder("\"");
            foreach (char c in value)
            {
                if (c == '\\' || c == '"') text.Append('\\').Append(c);
                else if (c < 32) text.Append("\\u").Append(((int)c).ToString("x4"));
                else text.Append(c);
            }
            return text.Append('"').ToString();
        }
    }
}
