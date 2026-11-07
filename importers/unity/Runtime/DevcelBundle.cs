using System.Collections;
using System;
using System.IO;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.Networking;

namespace Devcel.Unity
{
    /// <summary>
    /// Runtime helpers for passing bundles to generated DevcelDatabase classes
    /// in Devcel.Generated.* namespaces, handling whether StreamingAssets are real files on each platform.
    ///
    /// Usage with generated code:
    ///   // Desktop:
    ///   var db = Devcel.Generated.MyGame.DevcelDatabase.Open(
    ///       DevcelBundle.ResolveStreamingAssetsPath("Devcel/MyGame/master.json"));
    ///   // Example of loading text; FromJson also requires the target platform's native runtime:
    ///   yield return DevcelBundle.LoadText("Devcel/MyGame/master.json", json => {
    ///       var db = Devcel.Generated.MyGame.DevcelDatabase.FromJson(json);
    ///   });
    /// </summary>
    public static class DevcelBundle
    {
        public const uint RuntimeApiVersion = 1;

#if (UNITY_IOS || UNITY_WEBGL) && !UNITY_EDITOR
        private const string NativeLibrary = "__Internal";
#else
        private const string NativeLibrary = "devcel_runtime";
#endif
        [DllImport(NativeLibrary, CallingConvention = CallingConvention.Cdecl)]
        private static extern uint devcel_rt_api_version();

        /// <summary>Reject an incompatible native runtime before opening a schema-v1 bundle.</summary>
        public static void EnsureRuntimeApiVersion()
        {
            uint actual;
            try { actual = devcel_rt_api_version(); }
            catch (EntryPointNotFoundException error)
            {
                throw new InvalidOperationException("devcel-runtime API v1 is required. Align the CLI, SDK, and native runtime versions and regenerate.", error);
            }
            if (actual != RuntimeApiVersion)
                throw new InvalidOperationException($"devcel-runtime API mismatch. Required: {RuntimeApiVersion}; actual: {actual}.");
        }

        /// <summary>Explicit channel copy from a generated DevcelColor32 value. Straight alpha is preserved.</summary>
        public static Color32 ToUnityColor32(byte r, byte g, byte b, byte a) => new Color32(r, g, b, a);

        /// <summary>Explicit channel copy from a generated DevcelColorFloat value. No clamp, gamma conversion or premultiplication.</summary>
        public static Color ToUnityColor(float r, float g, float b, float a) => new Color(r, g, b, a);

        /// <summary>
        /// Resolve a path relative to StreamingAssets to an absolute path that can be opened directly.
        /// Supported on desktop (Windows, Mac, Linux) and in the Editor. On platforms such as Android
        /// without direct file access, use <see cref="LoadText"/>.
        /// </summary>
        public static string ResolveStreamingAssetsPath(string relativePath)
        {
            return Path.Combine(Application.streamingAssetsPath, relativePath);
        }

        /// <summary>
        /// Load bundle text from StreamingAssets, independently of native runtime platform support.
        /// UnityWebRequest can also read it from an Android jar.
        /// </summary>
        public static IEnumerator LoadText(string relativePath, System.Action<string> onLoaded)
        {
            string fullPath = ResolveStreamingAssetsPath(relativePath);

            // Distinguish platforms requiring file:// URLs from those supporting direct reads
            bool needsWebRequest =
                fullPath.Contains("://") ||                 // Android (jar:file://...)
                Application.platform == RuntimePlatform.Android;

            if (needsWebRequest)
            {
                using (var req = UnityWebRequest.Get(fullPath))
                {
                    yield return req.SendWebRequest();
                    if (req.result != UnityWebRequest.Result.Success)
                    {
                        Debug.LogError($"[Devcel] Failed to load bundle: {fullPath} ({req.error})");
                        onLoaded?.Invoke(null);
                        yield break;
                    }
                    onLoaded?.Invoke(req.downloadHandler.text);
                }
            }
            else
            {
                string text = File.Exists(fullPath) ? File.ReadAllText(fullPath) : null;
                if (text == null) Debug.LogError($"[Devcel] Bundle not found: {fullPath}");
                onLoaded?.Invoke(text);
                yield break;
            }
        }
    }
}
