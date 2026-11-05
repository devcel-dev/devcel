using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Managed preview cache only; never keeps a native database alive.</summary>
    internal static class DevcelReferenceCatalog
    {
        internal sealed class Entry
        {
            internal DevcelReferencePicker.Choice[] Choices;
            internal string Error;
            internal long Stamp, Length;
            internal bool Loading;
            internal double NextCheck;
        }
        private static readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>();
        internal static void Invalidate() { foreach (var item in entries.Values) { item.Stamp = -1; item.NextCheck = 0; } }
        internal static Entry Get(DevcelProjectConfig project, string table, DevcelInterfaceTargetAttribute target = null, DevcelImplementingTableAttribute[] allowed = null, string expectedUuid = null)
        {
            string path = Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName);
            string key = path + "\n" + table + "\n" + (target?.InterfaceUuid ?? "") + "\n" + expectedUuid;
            if (!entries.TryGetValue(key, out var entry)) entries.Add(key, entry = new Entry { Stamp = -1 });
            if (entry.Loading || EditorApplication.timeSinceStartup < entry.NextCheck) return entry;
            entry.NextCheck = EditorApplication.timeSinceStartup + 1;
            long stamp, length;
            try { var info = new FileInfo(path); stamp = info.LastWriteTimeUtc.Ticks; length = info.Length; }
            catch (Exception ex) { entry.Error = "Imported bundle unavailable: " + ex.Message; return entry; }
            if (stamp == entry.Stamp && length == entry.Length) return entry;
            entry.Loading = true;
            var inspector = EditorWindow.focusedWindow;
            EditorApplication.delayCall += () =>
            {
                try
                {
                    var choices = target == null ? DevcelReferencePicker.LoadChoices(project, table, expectedUuid) : DevcelReferencePicker.LoadInterfaceChoices(project, target.InterfaceUuid, allowed);
                    var after = new FileInfo(path);
                    if (after.LastWriteTimeUtc.Ticks != stamp || after.Length != length) return;
                    entry.Choices = choices; entry.Error = null; entry.Stamp = stamp; entry.Length = length;
                }
                catch (Exception ex) { entry.Error = "Cannot refresh records (last valid list retained): " + ex.Message; }
                finally { entry.Loading = false; if (inspector != null) inspector.Repaint(); }
            };
            return entry;
        }
    }
}
