using System;
using System.IO;
using UnityEditor;

namespace Devcel.Unity.Editor
{
    /// <summary>Checks the format/CPU instead of trusting the installed filename. Validate the ABI, signature, and dependencies separately on the target machine.</summary>
    internal static class DevcelNativeBinary
    {
        internal static bool Validate(string path, BuildTarget target, out string error)
        {
            error = null;
            try
            {
                using (var stream = File.OpenRead(path))
                using (var reader = new BinaryReader(stream))
                {
                    bool valid = false;
                    if (stream.Length >= 64 && target == BuildTarget.StandaloneLinux64)
                    {
                        valid = reader.ReadUInt32() == 0x464c457f && reader.ReadByte() == 2 && reader.ReadByte() == 1;
                        stream.Position = 16;
                        valid &= reader.ReadUInt16() == 3 && reader.ReadUInt16() == 62; // ELF64 little-endian ET_DYN, x86-64
                    }
                    else if (stream.Length >= 64 && target == BuildTarget.StandaloneWindows64)
                    {
                        valid = reader.ReadUInt16() == 0x5a4d;
                        stream.Position = 0x3c;
                        uint offset = reader.ReadUInt32();
                        valid &= offset >= 64 && offset <= stream.Length - 26;
                        if (valid)
                        {
                            stream.Position = offset;
                            valid = reader.ReadUInt32() == 0x4550 && reader.ReadUInt16() == 0x8664;
                            stream.Position = offset + 22;
                            valid &= (reader.ReadUInt16() & 0x2000) != 0 && reader.ReadUInt16() == 0x20b; // DLL, PE32+
                        }
                    }
                    else if (target == BuildTarget.StandaloneOSX) valid = IsUniversalDylib(reader);
                    else if (target == BuildTarget.Android) valid = IsAndroid(reader, path.Replace('\\', '/'));
                    else if (target == BuildTarget.iOS) valid = IsIosDeviceArchive(reader);
                    else if (target == BuildTarget.WebGL) valid = IsWebAssemblyArchive(reader);
                    if (valid) return true;
                }
                error = "The native runtime format/CPU does not match its target (macOS universal, Android ABI with 16 KB alignment, or iOS ARM64 device archive required): " + path;
            }
            catch (Exception ex) { error = "Cannot validate the native runtime: " + path + " (" + ex.Message + ")"; }
            return false;
        }

        private static bool IsWebAssemblyArchive(BinaryReader reader)
        {
            var stream = reader.BaseStream;
            if (stream.Length < 8 || System.Text.Encoding.ASCII.GetString(reader.ReadBytes(8)) != "!<arch>\n") return false;
            bool found = false;
            while (stream.Position < stream.Length)
            {
                if (stream.Length - stream.Position < 60) return false;
                byte[] header = reader.ReadBytes(60);
                string name = System.Text.Encoding.ASCII.GetString(header, 0, 16).Trim();
                if (header[58] != (byte)'`' || header[59] != (byte)'\n' ||
                    !long.TryParse(System.Text.Encoding.ASCII.GetString(header, 48, 10).Trim(), out long size) || size < 0 || size > stream.Length - stream.Position) return false;
                long start = stream.Position, end = start + size;
                if (name.StartsWith("#1/"))
                {
                    if (!int.TryParse(name.Substring(3), out int nameBytes) || nameBytes < 0 || nameBytes > size) return false;
                    start += nameBytes;
                }
                if (name != "/" && name != "//" && name != "/SYM64/")
                {
                    if (end - start < 8) return false;
                    stream.Position = start;
                    if (reader.ReadUInt32() != 0x6d736100 || reader.ReadUInt32() != 1) return false;
                    found = true;
                }
                stream.Position = end + (size & 1);
            }
            return found && stream.Position == stream.Length;
        }

        private static uint BigEndian32(BinaryReader reader)
        {
            uint value = reader.ReadUInt32();
            return ((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >> 8) & 0xff00) | (value >> 24);
        }
        private static bool IsAndroid(BinaryReader reader, string path)
        {
            var stream = reader.BaseStream;
            bool arm32 = path.Contains("/Android/armeabi-v7a/");
            bool x86 = path.Contains("/Android/x86/");
            bool is32 = arm32 || x86;
            bool arm64 = path.Contains("/Android/arm64-v8a/");
            bool x64 = path.Contains("/Android/x86_64/");
            if (!is32 && !arm64 && !x64) return false;
            if (stream.Length < 64 || reader.ReadUInt32() != 0x464c457f || reader.ReadByte() != (is32 ? 1 : 2) || reader.ReadByte() != 1) return false;
            stream.Position = 16;
            if (reader.ReadUInt16() != 3 || reader.ReadUInt16() != (arm32 ? 40 : x86 ? 3 : arm64 ? 183 : 62)) return false;
            stream.Position = is32 ? 28 : 32;
            ulong offset = is32 ? reader.ReadUInt32() : reader.ReadUInt64();
            stream.Position = is32 ? 42 : 54;
            ushort size = reader.ReadUInt16(), count = reader.ReadUInt16();
            if (size < (is32 ? 32 : 56) || count == 0 || offset > (ulong)stream.Length || (ulong)size * count > (ulong)stream.Length - offset) return false;
            bool load = false;
            for (int i = 0; i < count; i++)
            {
                stream.Position = (long)offset + i * size;
                if (reader.ReadUInt32() != 1) continue; // PT_LOAD
                load = true;
                if (!is32) stream.Position += 4;
                ulong fileOffset = is32 ? reader.ReadUInt32() : reader.ReadUInt64();
                ulong address = is32 ? reader.ReadUInt32() : reader.ReadUInt64();
                stream.Position = (long)offset + i * size + (is32 ? 28 : 48);
                ulong alignment = is32 ? reader.ReadUInt32() : reader.ReadUInt64();
                if (alignment < 16384 || (alignment & (alignment - 1)) != 0 || fileOffset % 16384 != address % 16384) return false;
            }
            return load;
        }

        private static bool IsIosDeviceArchive(BinaryReader reader)
        {
            var stream = reader.BaseStream;
            if (stream.Length < 8 || System.Text.Encoding.ASCII.GetString(reader.ReadBytes(8)) != "!<arch>\n") return false;
            bool deviceObject = false;
            while (stream.Position < stream.Length)
            {
                if (stream.Length - stream.Position < 60) return false;
                string name = System.Text.Encoding.ASCII.GetString(reader.ReadBytes(16)).Trim();
                stream.Position += 32;
                string length = System.Text.Encoding.ASCII.GetString(reader.ReadBytes(10)).Trim();
                if (reader.ReadByte() != 0x60 || reader.ReadByte() != 0x0a || !long.TryParse(length, out long size) || size < 0 || size > stream.Length - stream.Position) return false;
                long start = stream.Position, end = start + size;
                if (name.StartsWith("#1/", StringComparison.Ordinal))
                {
                    if (!int.TryParse(name.Substring(3), out int nameSize) || nameSize < 0 || nameSize > size) return false;
                    stream.Position += nameSize;
                }
                if (end - stream.Position >= 32 && reader.ReadUInt32() == 0xfeedfacf)
                {
                    if (reader.ReadUInt32() != 0x0100000c) return false;
                    reader.ReadUInt32();
                    if (reader.ReadUInt32() != 1) return false; // MH_OBJECT
                    uint count = reader.ReadUInt32(), bytes = reader.ReadUInt32();
                    stream.Position += 8;
                    if (bytes > end - stream.Position || count > bytes / 8) return false;
                    long commandsEnd = stream.Position + bytes;
                    for (uint i = 0; i < count; i++)
                    {
                        long command = stream.Position;
                        if (commandsEnd - command < 8) return false;
                        uint type = reader.ReadUInt32(), commandSize = reader.ReadUInt32();
                        if (commandSize < 8 || commandSize > commandsEnd - command) return false;
                        if (type == 0x32) // LC_BUILD_VERSION: iOS device, not Simulator/macOS
                        {
                            if (commandSize < 24 || reader.ReadUInt32() != 2) return false;
                            deviceObject = true;
                        }
                        else if (type == 0x25) deviceObject = true; // LC_VERSION_MIN_IPHONEOS
                        else if (type == 0x24 || type == 0x2f || type == 0x30) return false;
                        stream.Position = command + commandSize;
                    }
                }
                stream.Position = end + (size & 1);
                if (stream.Position > stream.Length) return false;
            }
            return deviceObject;
        }
        private static ulong BigEndian64(BinaryReader reader) => ((ulong)BigEndian32(reader) << 32) | BigEndian32(reader);
        private static bool IsUniversalDylib(BinaryReader reader)
        {
            if (reader.BaseStream.Length < 8) return false;
            uint magic = BigEndian32(reader);
            if (magic != 0xcafebabe && magic != 0xcafebabf) return false;
            bool fat64 = magic == 0xcafebabf, x64 = false, arm64 = false;
            uint count = BigEndian32(reader);
            if (count < 2 || count > 16) return false;
            long headerSize = 8 + count * (fat64 ? 32 : 20);
            for (uint i = 0; i < count; i++)
            {
                uint cpu = BigEndian32(reader);
                BigEndian32(reader); // subtype
                ulong offset = fat64 ? BigEndian64(reader) : BigEndian32(reader);
                ulong size = fat64 ? BigEndian64(reader) : BigEndian32(reader);
                BigEndian32(reader); // alignment
                if (fat64) BigEndian32(reader); // reserved
                long next = reader.BaseStream.Position;
                if (offset < (ulong)headerSize || offset > (ulong)reader.BaseStream.Length || size < 32 || size > (ulong)reader.BaseStream.Length - offset) return false;
                reader.BaseStream.Position = (long)offset;
                if (reader.ReadUInt32() != 0xfeedfacf || reader.ReadUInt32() != cpu) return false;
                reader.ReadUInt32();
                if (reader.ReadUInt32() != 6) return false; // MH_DYLIB
                x64 |= cpu == 0x01000007;
                arm64 |= cpu == 0x0100000c;
                reader.BaseStream.Position = next;
            }
            return x64 && arm64;
        }
    }
}
