using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace Devcel.Unity.Editor
{
    /// <summary>
    /// Names/IDs come from the bundle's schema; all counts, lookups and cell values are read
    /// through devcel-runtime. Opening one JSON text prevents metadata/snapshot races.
    /// </summary>
    internal sealed class DevcelPreviewData : IDisposable
    {
        [Serializable] internal sealed class Column { public string name; public string data_type; }
        [Serializable] internal sealed class Record { public string id; }
        [Serializable] internal sealed class Table { public string uuid; public string[] interfaces; public string name; public Column[] columns; public Record[] records; }
        [Serializable] private sealed class Bundle { public Table[] tables; }
        public Table[] Tables { get; private set; }
        private sealed class NativeHandle : SafeHandle
        {
            public NativeHandle(IntPtr pointer) : base(IntPtr.Zero, ownsHandle: true) { SetHandle(pointer); }
            public override bool IsInvalid => handle == IntPtr.Zero;
            protected override bool ReleaseHandle() { devcel_rt_close(handle); return true; }
        }
        private NativeHandle handle;
        private const string Dll = "devcel_runtime";
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeColor32 { public byte R, G, B, A; }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeColorFloat { public float R, G, B, A; }
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr devcel_rt_open_from_json([MarshalAs(UnmanagedType.LPUTF8Str)] string json);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern void devcel_rt_close(IntPtr db);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern int devcel_rt_table_index(NativeHandle db, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern int devcel_rt_row_count(NativeHandle db, int table);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern int devcel_rt_row_by_uuid(NativeHandle db, int table, [MarshalAs(UnmanagedType.LPUTF8Str)] string uuid);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern int devcel_rt_column_index(NativeHandle db, int table, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern long devcel_rt_get_i64(NativeHandle db, int table, int row, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern double devcel_rt_get_f64(NativeHandle db, int table, int row, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern int devcel_rt_get_bool(NativeHandle db, int table, int row, int col);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr devcel_rt_get_str(NativeHandle db, int table, int row, int col, out int length);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        private static extern int devcel_rt_get_color32(NativeHandle db, int table, int row, int col, out NativeColor32 value);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        private static extern int devcel_rt_get_color_float(NativeHandle db, int table, int row, int col, out NativeColorFloat value);

        public static DevcelPreviewData Open(string path)
        {
            return FromJson(File.ReadAllText(path));
        }

        internal static DevcelPreviewData FromJson(string json)
        {
            DevcelBundle.EnsureRuntimeApiVersion();
            var metadata = JsonUtility.FromJson<Bundle>(json);
            if (metadata?.tables == null) throw new InvalidDataException("The runtime bundle has no tables.");
            IntPtr native = devcel_rt_open_from_json(json);
            if (native == IntPtr.Zero) throw new InvalidDataException("devcel-runtime rejected the bundle. Check schema_version, content_hash, and the data.");
            return new DevcelPreviewData { handle = new NativeHandle(native), Tables = metadata.tables };
        }

        public int RowCount(int table) => devcel_rt_row_count(CheckedHandle(), TableIndex(table));
        public int RowById(int table, string id) => devcel_rt_row_by_uuid(CheckedHandle(), TableIndex(table), id);
        public string Read(int table, int row, int column)
        {
            var db = CheckedHandle();
            int tableIndex = TableIndex(table);
            if (row < 0 || row >= devcel_rt_row_count(db, tableIndex)) throw new ArgumentOutOfRangeException(nameof(row));
            var definition = Tables[table].columns[column];
            int col = devcel_rt_column_index(db, tableIndex, definition.name);
            if (col < 0) throw new InvalidDataException("Column not found: " + definition.name);
            switch (definition.data_type)
            {
                case "U8": case "I8": case "U16": case "I16": case "U32": case "I32": case "U64": case "I64":
                    return devcel_rt_get_i64(db, tableIndex, row, col).ToString(CultureInfo.InvariantCulture);
                case "F32": case "F64":
                    return devcel_rt_get_f64(db, tableIndex, row, col).ToString("R", CultureInfo.InvariantCulture);
                case "Color32":
                    var bytes = ReadColor32(table, row, column);
                    return string.Format(CultureInfo.InvariantCulture, "[{0},{1},{2},{3}]", bytes.r, bytes.g, bytes.b, bytes.a);
                case "ColorFloat":
                    var floats = ReadColorFloat(table, row, column);
                    return "[" + floats.r.ToString("R", CultureInfo.InvariantCulture) + "," + floats.g.ToString("R", CultureInfo.InvariantCulture)
                        + "," + floats.b.ToString("R", CultureInfo.InvariantCulture) + "," + floats.a.ToString("R", CultureInfo.InvariantCulture) + "]";
                case "Boolean": return devcel_rt_get_bool(db, tableIndex, row, col) != 0 ? "true" : "false";
                default:
                    // The returned pointer remains native-owned after P/Invoke returns. Keep the
                    // SafeHandle pinned until the copy completes, including concurrent Dispose.
                    bool retained = false;
                    try
                    {
                        db.DangerousAddRef(ref retained);
                        IntPtr pointer = devcel_rt_get_str(db, tableIndex, row, col, out int length);
                        if (pointer == IntPtr.Zero || length <= 0) return string.Empty;
                        var textBytes = new byte[length]; Marshal.Copy(pointer, textBytes, 0, length);
                        return Encoding.UTF8.GetString(textBytes);
                    }
                    finally { if (retained) db.DangerousRelease(); }
            }
        }

        public Color32 ReadColor32(int table, int row, int column)
        {
            var db = CheckedHandle();
            int tableIndex = TableIndex(table);
            int col = ColorColumn(table, row, column, tableIndex, "Color32");
            if (devcel_rt_get_color32(db, tableIndex, row, col, out var value) != 1)
                throw new InvalidDataException("Cannot get Color32: " + Tables[table].columns[column].name);
            return DevcelBundle.ToUnityColor32(value.R, value.G, value.B, value.A);
        }

        public Color ReadColorFloat(int table, int row, int column)
        {
            var db = CheckedHandle();
            int tableIndex = TableIndex(table);
            int col = ColorColumn(table, row, column, tableIndex, "ColorFloat");
            if (devcel_rt_get_color_float(db, tableIndex, row, col, out var value) != 1)
                throw new InvalidDataException("Cannot get ColorFloat: " + Tables[table].columns[column].name);
            return DevcelBundle.ToUnityColor(value.R, value.G, value.B, value.A);
        }

        private int ColorColumn(int table, int row, int column, int tableIndex, string expectedType)
        {
            if (row < 0 || row >= devcel_rt_row_count(CheckedHandle(), tableIndex)) throw new ArgumentOutOfRangeException(nameof(row));
            var definition = Tables[table].columns[column];
            if (definition.data_type != expectedType) throw new InvalidDataException(expectedType + " type expected: " + definition.name);
            int col = devcel_rt_column_index(CheckedHandle(), tableIndex, definition.name);
            if (col < 0) throw new InvalidDataException("Column not found: " + definition.name);
            return col;
        }

        public string RecordLabel(int table, int record)
        {
            string id = Tables[table].records[record].id;
            int row = RowById(table, id);
            if (row < 0) return "[missing] " + id;
            var columns = Tables[table].columns;
            for (int i = 0; i < columns.Length; i++)
                if (columns[i].data_type == "String")
                {
                    string value = Read(table, row, i);
                    if (!string.IsNullOrEmpty(value)) return value + " (" + id + ")";
                }
            return id;
        }

        private int TableIndex(int table)
        {
            int result = devcel_rt_table_index(CheckedHandle(), Tables[table].name);
            if (result < 0) throw new InvalidDataException("Table not found: " + Tables[table].name);
            return result;
        }
        private NativeHandle CheckedHandle() => handle != null && !handle.IsClosed && !handle.IsInvalid ? handle : throw new ObjectDisposedException(nameof(DevcelPreviewData));
        public void Dispose() { handle?.Dispose(); }
    }
}
