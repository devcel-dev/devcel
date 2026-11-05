using System;
namespace UnityEngine
{
    public static class Application { public static string dataPath; }
    public static class JsonUtility
    {
        public static T FromJson<T>(string text) { throw new InvalidOperationException("JSON import is outside this version-contract harness"); }
    }
}
namespace UnityEditor
{
    public static class AssetDatabase
    {
        public static string ScriptPath;
        public static string[] FindAssets(string filter) => new[] { "fixture-script" };
        public static string GUIDToAssetPath(string guid) => ScriptPath;
    }
}
namespace UnityEditor.PackageManager
{
    public class PackageInfo
    {
        public string resolvedPath;
        public string name;
        public static string Root;
        public static bool UseUpm;
        public static PackageInfo FindForAssembly(System.Reflection.Assembly assembly) =>
            UseUpm ? new PackageInfo { resolvedPath = Root, name = "org.devcel.unity" } : null;
    }
}
