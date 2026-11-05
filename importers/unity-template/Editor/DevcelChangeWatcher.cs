using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Auto acquires a shared CLI P2P server; FileWatch remains its offline fallback.</summary>
    [InitializeOnLoad]
    public static class DevcelChangeWatcher
    {
        private sealed class Subscription : IDisposable
        {
            public DevcelProjectConfig Project;
            public FileSystemWatcher Files;
            public FileSystemWatcher Directories;
            public DevcelCliWatchProcess P2P;
            public DevcelSyncMode Mode;
            public string Error;
            public void Dispose() { P2P?.Dispose(); if (Files != null) { Files.EnableRaisingEvents = false; Files.Dispose(); } if (Directories != null) { Directories.EnableRaisingEvents = false; Directories.Dispose(); } }
        }
        private static readonly List<Subscription> subscriptions = new List<Subscription>();
        private static readonly object gate = new object();
        private static readonly Dictionary<DevcelProjectConfig, double> dirty = new Dictionary<DevcelProjectConfig, double>();
        private static readonly Stopwatch clock = Stopwatch.StartNew();
        private static int generation;
        private static bool rebuildRequested;

        static DevcelChangeWatcher()
        {
            EditorApplication.delayCall += Rebuild;
            EditorApplication.update += OnUpdate;
            AssemblyReloadEvents.beforeAssemblyReload += DisposeWatchers;
            EditorApplication.quitting += DisposeWatchers;
        }

        /// <summary>Batches settings edits and rebuilds watchers outside GUI rendering.</summary>
        public static void RequestRebuild() { rebuildRequested = true; }

        public static void Rebuild()
        {
            bool importSettingsChanges = rebuildRequested;
            DisposeWatchers();
            rebuildRequested = false;
            var settings = DevcelImporterSettings.Instance;
            if (settings.syncMode == DevcelSyncMode.Off) return;
            int currentGeneration = generation;
            foreach (var project in settings.projects)
            {
                if (project == null || !project.autoSync || !project.TryValidate(settings, out _)) continue;
                var subscription = new Subscription { Project = project, Mode = settings.syncMode };
                subscriptions.Add(subscription);
                if (importSettingsChanges) MarkDirty(project, currentGeneration);
                try
                {
                    string path = DevcelPaths.ResolveFromProjectRoot(project.devcelProjectPath);
                    string directory = File.Exists(path) ? Path.GetDirectoryName(path) : path;
                    if (settings.syncMode == DevcelSyncMode.P2P || settings.syncMode == DevcelSyncMode.Auto)
                    {
                        subscription.P2P = new DevcelCliWatchProcess(path);
                        subscription.P2P.Changed += () => MarkDirty(project, currentGeneration);
                    }
                    // Pull reads saved files. A P2P snapshot can arrive before the delayed
                    // disk save, so all active modes must observe that later publication.
                    if (settings.syncMode == DevcelSyncMode.FileWatch || settings.syncMode == DevcelSyncMode.Auto || settings.syncMode == DevcelSyncMode.P2P)
                    {
                        if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) continue;
                        var watcher = new FileSystemWatcher(directory) {
                            IncludeSubdirectories = true,
                            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                        };
                        subscription.Files = watcher;
                        FileSystemEventHandler changed = (_, e) => {
                            if (Relevant(e.FullPath)) MarkDirty(project, currentGeneration);
                        };
                        watcher.Changed += changed; watcher.Created += changed; watcher.Deleted += changed;
                        watcher.Renamed += (_, e) => {
                            if (Relevant(e.OldFullPath) || Relevant(e.FullPath)) MarkDirty(project, currentGeneration);
                        };
                        // Overflow means individual changes were lost: perform a full export.
                        watcher.Error += (_, __) => MarkDirty(project, currentGeneration);
                        watcher.EnableRaisingEvents = true;
                        // Directory names may contain dots; extension filtering cannot identify them.
                        var directories = new FileSystemWatcher(directory) {
                            IncludeSubdirectories = true, NotifyFilter = NotifyFilters.DirectoryName,
                        };
                        subscription.Directories = directories;
                        directories.Created += (_, __) => MarkDirty(project, currentGeneration);
                        directories.Deleted += (_, __) => MarkDirty(project, currentGeneration);
                        directories.Renamed += (_, __) => MarkDirty(project, currentGeneration);
                        directories.Error += (_, __) => MarkDirty(project, currentGeneration);
                        directories.EnableRaisingEvents = true;
                    }
                }
                catch (Exception ex)
                {
                    subscription.Error = "Cannot start file monitoring: " + ex.Message;
                    DevcelImporterSettings.LogWarning($"Cannot start monitoring ({project.projectName}): {ex.Message}");
                }
            }
        }

        private static bool Relevant(string path) =>
            path.EndsWith(".table.toml", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith(".interface.toml", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith(".devcelproj.toml", StringComparison.OrdinalIgnoreCase);

        private static void MarkDirty(DevcelProjectConfig project, int expectedGeneration)
        {
            lock (gate) { if (generation == expectedGeneration) dirty[project] = clock.Elapsed.TotalSeconds; }
        }

        public static string GetStatus(DevcelProjectConfig project)
        {
            var subscription = subscriptions.Find(s => ReferenceEquals(s.Project, project));
            if (subscription == null) return "Stopped";
            if (subscription.P2P != null && subscription.P2P.Connected) return "P2P connected";
            if (subscription.Files != null && subscription.Mode != DevcelSyncMode.P2P)
                return subscription.P2P == null ? "FileWatch" : "FileWatch (waiting for P2P auto-start/reconnection)";
            if (subscription.P2P == null) return "FileWatch stopped";
            return subscription.P2P?.LastError == null ? "Waiting for P2P auto-start/connection" : "Waiting for P2P reconnection";
        }

        public static string GetError(DevcelProjectConfig project)
        {
            var subscription = subscriptions.Find(s => ReferenceEquals(s.Project, project));
            if (subscription == null) return null;
            string p2pError = subscription.P2P?.LastError;
            return string.IsNullOrEmpty(subscription.Error) ? p2pError : subscription.Error +
                (string.IsNullOrEmpty(p2pError) ? string.Empty : "\n" + p2pError);
        }

        private static void OnUpdate()
        {
            if (rebuildRequested) Rebuild();
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            double now = clock.Elapsed.TotalSeconds;
            foreach (var subscription in subscriptions) subscription.P2P?.Tick(now);
            var settings = DevcelImporterSettings.Instance;
            var ready = new List<DevcelProjectConfig>();
            lock (gate)
            {
                foreach (var pair in dirty)
                    if (now - pair.Value >= Math.Max(0, settings.debounceMs) / 1000.0) ready.Add(pair.Key);
                foreach (var project in ready) dirty.Remove(project);
            }
            foreach (var project in ready)
            {
                if (settings.syncMode == DevcelSyncMode.Off || !project.autoSync || !settings.projects.Contains(project)) continue;
                // Strict P2P never falls back to a disconnected local Pull. Reconnect
                // queues a new change, including any files saved while disconnected.
                if (settings.syncMode == DevcelSyncMode.P2P &&
                    subscriptions.Find(s => ReferenceEquals(s.Project, project))?.P2P?.Connected != true) continue;
                if (!DevcelExporter.ExportProject(project, settings))
                {
                    // Retry after a quiet period; a transient export failure must not lose the change.
                    lock (gate) dirty[project] = now + 5;
                }
            }
        }

        private static void DisposeWatchers()
        {
            lock (gate) { generation++; dirty.Clear(); }
            foreach (var subscription in subscriptions) subscription.Dispose();
            subscriptions.Clear();
        }
    }
}
