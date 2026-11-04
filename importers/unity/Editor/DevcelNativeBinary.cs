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
                    if (valid) return true;
                }
                error = "The native runtime format/CPU does not match its location (macOS requires an x86_64+arm64 universal dylib): " + path;
            }
            catch (Exception ex) { error = "Cannot validate the native runtime: " + path + " (" + ex.Message + ")"; }
            return false;
        }

        private static uint BigEndian32(BinaryReader reader)
        {
            uint value = reader.ReadUInt32();
            return ((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >> 8) & 0xff00) | (value >> 24);
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
