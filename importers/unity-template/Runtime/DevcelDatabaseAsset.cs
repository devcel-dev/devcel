using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Devcel.Unity
{
    /// <summary>Generated owners can atomically adopt a validated replacement without invalidating live handles.</summary>
    public interface IDevcelReloadableDatabase { bool TryReplaceDatabase(IDisposable replacement); }

    /// <summary>Only distributable runtime bundles belong here; authoring/CLI paths stay in Editor settings.</summary>
    [Serializable]
    public sealed class DevcelProjectBundle
    {
        public string projectName = string.Empty;
        [Tooltip("Current runtime JSON bundle imported as TextAsset. Choose this OR a StreamingAssets path.")]
        public TextAsset bundle;
        [Tooltip("Relative path under StreamingAssets, for example Devcel/Game/master.json.")]
        public string streamingAssetsPath = string.Empty;
    }

    /// <summary>
    /// Inspector-assignable, multi-project database owner. Typed factories create generated
    /// databases, which read and validate canonical bundles through the native runtime.
    /// Access on Unity's main thread. Do not dispose a borrowed database; the asset owns its lifetime.
    /// </summary>
    [CreateAssetMenu(fileName = "DevcelDatabase", menuName = "Devcel/Runtime Database")]
    public sealed class DevcelDatabaseAsset : ScriptableObject
    {
        [SerializeField] private List<DevcelProjectBundle> projects = new List<DevcelProjectBundle>();
        private readonly Dictionary<string, IDisposable> opened = new Dictionary<string, IDisposable>(StringComparer.Ordinal);
        public event Action<string> ProjectReloaded;
        public int ProjectCount => projects.Count;
        public IReadOnlyList<DevcelProjectBundle> Sources => projects.AsReadOnly();

        public IReadOnlyList<string> GetProjectNames()
        {
            ValidateSources();
            var names = new List<string>();
            foreach (var source in projects) names.Add(source.projectName);
            return names;
        }

        public bool HasProject(string projectName)
        {
            ValidateSources();
            return projects.Exists(source => source.projectName == projectName);
        }

        /// <summary>Factories should be the generated DevcelDatabase.Open and DevcelDatabase.FromJson.</summary>
        public T GetDatabase<T>(string projectName, Func<string, T> openFile, Func<string, T> fromJson)
            where T : class, IDisposable
        {
            var source = FindSource(projectName);
            if (opened.TryGetValue(projectName, out var existing))
                return existing as T ?? throw new InvalidOperationException("This project is already bound to another generated database type.");
            T database = OpenSource(source, openFile, fromJson);
            RequireUnowned(database);
            opened.Add(projectName, database);
            return database;
        }

        /// <summary>Explicit bundle refresh. A failed open preserves the current database and its rows.</summary>
        public T ReopenDatabase<T>(string projectName, Func<string, T> openFile, Func<string, T> fromJson)
            where T : class, IDisposable
        {
            var source = FindSource(projectName);
            if (opened.TryGetValue(projectName, out var existing) && !(existing is T))
                throw new InvalidOperationException("This project is already bound to another generated database type.");
            T replacement = OpenSource(source, openFile, fromJson);
            RequireUnowned(replacement);
            if (existing is IDevcelReloadableDatabase stable && stable.TryReplaceDatabase(replacement))
            {
                replacement.Dispose();
                ProjectReloaded?.Invoke(projectName);
                return (T)existing;
            }
            opened[projectName] = replacement;
            existing?.Dispose();
            ProjectReloaded?.Invoke(projectName);
            return replacement;
        }

        public void CloseProject(string projectName)
        {
            if (!opened.TryGetValue(projectName, out var database)) return;
            opened.Remove(projectName);
            database.Dispose();
        }

        /// <summary>Closes every owned native snapshot; previously obtained tables/rows become invalid.</summary>
        public void CloseAll()
        {
            var databases = new List<IDisposable>(opened.Values);
            opened.Clear();
            foreach (var database in databases) database.Dispose();
        }

        public void ValidateSources()
        {
            if (projects == null) throw new InvalidOperationException("Devcel runtime project list is missing.");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in projects)
            {
                if (source == null || string.IsNullOrWhiteSpace(source.projectName) || !names.Add(source.projectName))
                    throw new InvalidOperationException("Devcel runtime projects require unique, nonempty names.");
                bool hasPath = !string.IsNullOrWhiteSpace(source.streamingAssetsPath);
                if ((source.bundle != null) == hasPath)
                    throw new InvalidOperationException(source.projectName + ": choose exactly one TextAsset or StreamingAssets path.");
                if (hasPath) ResolvePath(source.streamingAssetsPath);
            }
        }

        private void RequireUnowned(IDisposable database)
        {
            foreach (var existing in opened.Values)
                if (ReferenceEquals(existing, database))
                    throw new InvalidOperationException("A generated database factory must return a new instance; this instance is already owned.");
        }

        private DevcelProjectBundle FindSource(string projectName)
        {
            ValidateSources();
            return projects.Find(source => source.projectName == projectName)
                ?? throw new KeyNotFoundException("Devcel runtime project is not registered: " + projectName);
        }

        private static T OpenSource<T>(DevcelProjectBundle source, Func<string, T> openFile, Func<string, T> fromJson)
            where T : class, IDisposable
        {
            T result;
            if (source.bundle != null)
                result = (fromJson ?? throw new ArgumentNullException(nameof(fromJson)))(source.bundle.text);
            else
                result = (openFile ?? throw new ArgumentNullException(nameof(openFile)))(ResolvePath(source.streamingAssetsPath));
            return result ?? throw new InvalidOperationException("The generated database factory returned null.");
        }

        private static string ResolvePath(string relativePath)
        {
            string normalized = relativePath.Replace('\\', '/');
            if (Path.IsPathRooted(relativePath) || normalized.Contains(":") ||
                Array.Exists(normalized.Split('/'), part => part == ".." || part == "." || part.Length == 0))
                throw new InvalidOperationException("A bundle path must stay inside StreamingAssets.");
            return DevcelBundle.ResolveStreamingAssetsPath(normalized);
        }

        private void OnDisable() { CloseAll(); }
    }
}
