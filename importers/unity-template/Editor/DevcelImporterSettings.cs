using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Environment type, used to switch versions by environment.</summary>
    public enum DevcelEnvironment
    {
        Development,
        Staging,
        Production
    }

    /// <summary>Change detection method.</summary>
    public enum DevcelSyncMode
    {
        /// <summary>No automatic import (manual import only).</summary>
        Off = 0,

        /// <summary>Automatically exports through file monitoring.</summary>
        FileWatch = 1,

        /// <summary>The bundled CLI automatically acquires a server and exports through a P2P subscription.</summary>
        P2P = 2,

        /// <summary>The bundled CLI automatically acquires a P2P server. Uses FileWatch while disconnected.</summary>
        Auto = 3
    }

    /// <summary>Maps environments to content versions.</summary>
    [Serializable]
    public class DevcelEnvironmentVersion
    {
        public DevcelEnvironment environment = DevcelEnvironment.Development;

        /// <summary>-1 includes all records. The filter range is 0..4294967295, matching Rust's u32.</summary>
        public long contentVersion = -1;

        public long? AsNullable()
        {
            long value = contentVersion;
            if (value < -1 || value > uint.MaxValue)
                throw new ArgumentOutOfRangeException(nameof(contentVersion), "Version must be -1 (all records) or 0..4294967295.");
            return value == -1 ? (long?)null : value;
        }
    }

    /// <summary>Import settings for one Devcel project.</summary>
    [Serializable]
    public class DevcelProjectConfig
    {
        [Tooltip("Unique identifier used for the generated namespace suffix and bundle placement")]
        public string projectName = string.Empty;

        [Tooltip("Path relative to the Unity project root (the parent of Assets), pointing to a .devcelproj.toml file or its directory. May be outside Assets")]
        public string devcelProjectPath = string.Empty;

        [Tooltip("Generated C# output directory (under Assets)")]
        public string codeOutputFolder = string.Empty;

        [Tooltip("Bundle JSON output directory")]
        public string jsonOutputFolder = string.Empty;

        [Tooltip("Bundle filename")]
        public string bundleFileName = "master.json";

        [Tooltip("Generated code namespace (blank for automatic: Devcel.Generated.<projectName>)")]
        public string codeNamespace = string.Empty;

        [Tooltip("Generated C# root class name (blank for DevcelDatabase; does not change table or row type names)")]
        public string codeClassName = string.Empty;

        [Tooltip("Export mode")]
        public bool minimal = false;

        [Tooltip("Whether to enable automatic import for this project")]
        public bool autoSync = true;

        [Tooltip("Content version for each environment")]
        public List<DevcelEnvironmentVersion> environments = new List<DevcelEnvironmentVersion>
        {
            new DevcelEnvironmentVersion { environment = DevcelEnvironment.Development, contentVersion = -1 },
        };

        public List<string> row_include_tags = new List<string>();
        public List<string> row_exclude_tags = new List<string>();
        public List<string> column_include_tags = new List<string>();
        public List<string> column_exclude_tags = new List<string>();

        // Runtime state (not serialized)
        [NonSerialized] public string lastContentHash;
        [NonSerialized] public string lastPullStatus = "Not checked";
        [NonSerialized] public DateTime lastExport;
        [NonSerialized] public string lastError;
        [NonSerialized] public bool lastExportCodeChanged;

        public bool IsValid() =>
            !string.IsNullOrEmpty(projectName) && !string.IsNullOrEmpty(devcelProjectPath);

        public string GetCodeOutputFolder() =>
            string.IsNullOrEmpty(codeOutputFolder)
                ? $"Assets/DevcelGenerated/{projectName}"
                : codeOutputFolder;

        public string GetJsonOutputFolder() =>
            string.IsNullOrEmpty(jsonOutputFolder)
                ? $"Assets/StreamingAssets/Devcel/{projectName}"
                : jsonOutputFolder;

        public string GetNamespace() =>
            string.IsNullOrEmpty(codeNamespace)
                ? $"Devcel.Generated.{SanitizeNamespace(projectName)}"
                : codeNamespace;

        public string GetClassName() =>
            string.IsNullOrWhiteSpace(codeClassName) ? "DevcelDatabase" : codeClassName;

        /// <summary>Returns the contentVersion for the current environment (-1 becomes null).</summary>
        public long? GetContentVersion(DevcelEnvironment env)
        {
            if (!DevcelConfigValidation.ValidateEnvironments(this, env, out string error))
                throw new InvalidOperationException(error);
            return environments.Find(e => e.environment == env).AsNullable();
        }

        public bool TryValidate(DevcelImporterSettings settings, out string error) =>
            DevcelConfigValidation.Validate(this, settings, out error);

        private static string SanitizeNamespace(string name)
        {
            var parts = (name ?? string.Empty).Split('.');
            for (int p = 0; p < parts.Length; p++)
            {
                var chars = parts[p].ToCharArray();
                for (int i = 0; i < chars.Length; i++)
                    if (!char.IsLetterOrDigit(chars[i]) && chars[i] != '_') chars[i] = '_';
                string part = new string(chars);
                if (part.Length == 0) part = "_";
                if (char.IsDigit(part[0]) || DevcelConfigValidation.IsKeyword(part)) part = "_" + part;
                parts[p] = part;
            }
            return string.Join(".", parts);
        }

    }

    /// <summary>Devcel Unity Importer settings.</summary>
    public class DevcelImporterSettings : ScriptableObject
    {
        public const string SettingsAssetPath = "Assets/DevcelUnity/Editor/DevcelImporterSettings.asset";
        private const int SettingsSchemaVersion = 1;
        // No initializer: assets lacking this field are rejected, never silently rewritten.
        [SerializeField, HideInInspector] private int settingsSchemaVersion;

        [Header("Projects")]
        [SerializeField] public List<DevcelProjectConfig> projects = new List<DevcelProjectConfig>();

        [Header("General")]
        [Tooltip("Current environment shared by all projects")]
        public DevcelEnvironment activeEnvironment = DevcelEnvironment.Development;

        [Tooltip("Change detection method")]
        // Explicitly saved Off (0) remains Off when an asset is loaded.
        public DevcelSyncMode syncMode = DevcelSyncMode.Auto;

        [Tooltip("Change detection debounce interval (milliseconds)")]
        public int debounceMs = 500;

        [Tooltip("Automatically export all projects before a Player build")]
        public bool exportOnBuild = false;

        [Tooltip("Hot-reload data changes into the runtime during Play mode")]
        public bool reloadInPlayMode = true;

        [Tooltip("Enable debug logging")]
        public bool enableDebugLogs = true;

        private static DevcelImporterSettings _instance;

        public static DevcelImporterSettings Instance
        {
            get
            {
                if (_instance == null) _instance = LoadOrCreate();
                return _instance;
            }
        }

        private static DevcelImporterSettings LoadOrCreate()
        {
            var settings = AssetDatabase.LoadAssetAtPath<DevcelImporterSettings>(SettingsAssetPath);
            if (settings != null)
            {
                if (settings.settingsSchemaVersion != SettingsSchemaVersion)
                    throw new InvalidOperationException("Devcel editor settings require schema 1. Check the settings asset (no automatic changes will be made).");
                return settings;
            }
            if (File.Exists(DevcelPaths.ToAbsolute(SettingsAssetPath)))
                throw new InvalidOperationException("Cannot load the Devcel settings asset. Check the existing file (it will not be overwritten automatically).");
            EnsureSettingsFolder();
            settings = CreateInstance<DevcelImporterSettings>();
            settings.settingsSchemaVersion = SettingsSchemaVersion;
            AssetDatabase.CreateAsset(settings, SettingsAssetPath);
            AssetDatabase.SaveAssets();
            Log($"Created settings: {SettingsAssetPath}");
            return settings;
        }

        private static void EnsureSettingsFolder()
        {
            string current = "Assets";
            foreach (string part in new[] { "DevcelUnity", "Editor" })
            {
                string next = current + "/" + part;
                if (!AssetDatabase.IsValidFolder(next) && string.IsNullOrEmpty(AssetDatabase.CreateFolder(current, part)))
                    throw new InvalidOperationException("Cannot create the settings folder: " + next);
                current = next;
            }
        }

        public void Save()
        {
            if (settingsSchemaVersion != SettingsSchemaVersion)
                throw new InvalidOperationException("Cannot save unsupported Devcel editor settings.");
            // Explicit saves from either UI use one portable representation. Validate all
            // path conversions before changing any serialized value.
            var paths = new List<string[]>();
            foreach (var project in projects)
            {
                if (project == null) throw new InvalidOperationException("The source project settings are null.");
                paths.Add(new[] {
                    DevcelPaths.ToProjectRelative(project.devcelProjectPath),
                    DevcelPaths.ToProjectRelative(project.codeOutputFolder),
                    DevcelPaths.ToProjectRelative(project.jsonOutputFolder)
                });
            }
            for (int index = 0; index < projects.Count; index++)
            {
                projects[index].devcelProjectPath = paths[index][0];
                projects[index].codeOutputFolder = paths[index][1];
                projects[index].jsonOutputFolder = paths[index][2];
            }
            EditorUtility.SetDirty(this);
            AssetDatabase.SaveAssetIfDirty(this);
            DevcelChangeWatcher.RequestRebuild();
        }

        public static void Log(string msg)
        {
            if (_instance == null || _instance.enableDebugLogs) Debug.Log($"[Devcel] {msg}");
        }

        public static void LogWarning(string msg) => Debug.LogWarning($"[Devcel] {msg}");
        public static void LogError(string msg) => Debug.LogError($"[Devcel] {msg}");
    }
}
