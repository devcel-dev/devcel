using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
namespace UnityEngine
{
    public class ScriptableObject
    {
        public static T CreateInstance<T>() where T : new() => new T();
    }
    [AttributeUsage(AttributeTargets.Field)]
    public class TooltipAttribute : Attribute
    {
        public TooltipAttribute(string x)
        {
        }
    }
    [AttributeUsage(AttributeTargets.Field)]
    public class HeaderAttribute : Attribute
    {
        public HeaderAttribute(string x)
        {
        }
    }
    [AttributeUsage(AttributeTargets.Field)]
    public class SerializeField : Attribute
    {
    }
    [AttributeUsage(AttributeTargets.Field)]
    public class HideInInspector : Attribute
    {
    }
    public struct Vector2
    {
        public Vector2(float x, float y)
        {
        }
    }
    public static class Debug
    {
        public static List<string> Logs = new List<string>(); public static void Log(object x) => Logs.Add(x.ToString()); public static void LogWarning(object x) => Logs.Add(x.ToString()); public static void LogError(object x) => Logs.Add(x.ToString());
    }
    public static class JsonUtility
    {
        public static T FromJson<T>(string x) => JsonSerializer.Deserialize<T>(x, new JsonSerializerOptions { IncludeFields = true });
    }
    public static class GUILayout
    {
        public static bool Button(string x, params object[] a) => false; public static object Height(int x) => null;
    }
}
namespace UnityEditor
{
    [AttributeUsage(AttributeTargets.Class)]
    public class InitializeOnLoadAttribute : Attribute
    {
    }
    [AttributeUsage(AttributeTargets.Method)]
    public class MenuItem : Attribute
    {
        public int priority; public MenuItem(string x)
        {
        }
    }
    public class EditorWindow
    {
        public UnityEngine.Vector2 minSize; public static T GetWindow<T>(string x) where T : new() => new T(); public void Show()
        {
        }
        public void Repaint()
        {
        }
    }
    public static class EditorApplication
    {
        public static event Action delayCall, update, quitting; public static bool isCompiling, isUpdating; public static void Tick() => update?.Invoke(); public static void Quit() => quitting?.Invoke(); public static void Delayed()
        {
            var d = delayCall;
            delayCall = null;
            d?.Invoke();
        }
    }
    public static class AssemblyReloadEvents
    {
        public static event Action beforeAssemblyReload; public static void Reload() => beforeAssemblyReload?.Invoke();
    }
    public static class AssetDatabase
    {
        public static object Saved; public static T LoadAssetAtPath<T>(string x) where T : class => Saved as T; public static void CreateAsset(object x, string p) => Saved = x; public static void SaveAssets()
        {
        }
        public static bool IsValidFolder(string p) => true; public static string CreateFolder(string a, string b) => a + b; public static void SaveAssetIfDirty(object x) => Saved = x;
    }
    public static class EditorUtility
    {
        public static void SetDirty(object x)
        {
        }
    }
    public enum MessageType
    {
        Info, Warning, Error
    }
    public static class EditorGUI
    {
        public class DisabledScope : IDisposable
        {
            public DisabledScope(bool x)
            {
            }
            public void Dispose()
            {
            }
        }
        public static void BeginChangeCheck()
        {
        }
        public static bool EndChangeCheck() => false;
    }
    public static class EditorStyles
    {
        public static object miniBoldLabel, boldLabel, wordWrappedLabel, helpBox, miniLabel;
    }
    public static class EditorGUILayout
    {
        public static void LabelField(string x, params object[] y)
        {
        }
        public static bool Foldout(bool b, string x) => b; public static Enum EnumPopup(string x, Enum e) => e; public static bool Toggle(string x, bool b) => b; public static void HelpBox(string x, MessageType t)
        {
        }
        public static UnityEngine.Vector2 BeginScrollView(UnityEngine.Vector2 x) => x; public static void EndScrollView()
        {
        }
        public static void Space()
        {
        }
        public static void BeginVertical(object x)
        {
        }
        public static void EndVertical()
        {
        }
        public static void BeginHorizontal()
        {
        }
        public static void EndHorizontal()
        {
        }
    }
}
namespace Devcel.Unity.Editor
{
    public static class DevcelPaths
    {
        public static string CliPath, Root, Failure; public static int Starts; public static string PrepareCliPath()
        {
            Starts++;
            if (Failure != null)
                throw new IOException(Failure);
            return CliPath;
        }
        public static string ResolveFromProjectRoot(string p) => Path.GetFullPath(p, Root); public static string ToAbsolute(string p) => ResolveFromProjectRoot(p); public static string ToProjectRelative(string p) => p;
    }
    public static class DevcelConfigValidation
    {
        public static bool ValidateEnvironments(DevcelProjectConfig x, DevcelEnvironment e, out string error)
        {
            error = null;
            return true;
        }
        public static bool Validate(DevcelProjectConfig x, DevcelImporterSettings s, out string error)
        {
            error = null;
            return true;
        }
        public static bool IsKeyword(string x) => false;
    }
    public static class DevcelExporter
    {
        public static List<string> Exports = new List<string>(); public static bool ExportProject(DevcelProjectConfig p, DevcelImporterSettings s)
        {
            Exports.Add(p.projectName);
            return true;
        }
        public static bool ExportAll(bool onlyAutoSync) => true; public static void CheckStatus(DevcelImporterSettings s)
        {
        }
    }
    public static class DevcelSetupWizard
    {
        public static void Open()
        {
        }
        public static void Open(DevcelProjectConfig p)
        {
        }
    }
    public static class DevcelPreviewWindow
    {
        public static void Open(DevcelProjectConfig p)
        {
        }
    }
}
