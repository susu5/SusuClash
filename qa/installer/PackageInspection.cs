using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Passive package inspection only. Never loads the native UI DLL or executes MSI actions.
public static class SusuMsiInspection
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenDatabaseW")]
    private static extern uint OpenDatabase(string path, IntPtr persist, out uint database);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDatabaseOpenViewW")]
    private static extern uint OpenView(uint database, string query, out uint view);
    [DllImport("msi.dll", EntryPoint = "MsiViewExecute")]
    private static extern uint Execute(uint view, uint record);
    [DllImport("msi.dll", EntryPoint = "MsiViewFetch")]
    private static extern uint Fetch(uint view, out uint record);
    [DllImport("msi.dll", EntryPoint = "MsiRecordReadStream")]
    private static extern uint ReadStream(uint record, uint field, byte[] buffer, ref uint count);
    [DllImport("msi.dll", EntryPoint = "MsiCloseHandle")]
    private static extern uint Close(uint handle);
    private static void Success(uint result) { if (result != 0) throw new Win32Exception((int)result); }

    public static byte[] ReadEmbeddedStream(string path, string id)
    {
        return ReadTableStream(path, "MsiEmbeddedUI", "MsiEmbeddedUI", id);
    }
    public static byte[] ReadBinaryStream(string path, string id)
    {
        return ReadTableStream(path, "Binary", "Name", id);
    }
    private static byte[] ReadTableStream(string path, string table, string key, string id)
    {
        uint database = 0, view = 0, record = 0;
        try
        {
            Success(OpenDatabase(path, IntPtr.Zero, out database));
            Success(OpenView(database, "SELECT `Data` FROM `" + table + "` WHERE `" + key + "` = '" + id.Replace("'", "''") + "'", out view));
            Success(Execute(view, 0)); Success(Fetch(view, out record));
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[65536];
                while (true)
                {
                    uint count = (uint)buffer.Length; Success(ReadStream(record, 1, buffer, ref count));
                    if (count == 0) break;
                    if (output.Length + count > 64 * 1024 * 1024) throw new InvalidDataException("Embedded UI stream exceeds 64 MiB.");
                    output.Write(buffer, 0, (int)count);
                }
                return output.ToArray();
            }
        }
        finally { if (record != 0) Close(record); if (view != 0) Close(view); if (database != 0) Close(database); }
    }

    private static ushort U16(byte[] bytes, int at) { Bounds(bytes, at, 2); return BitConverter.ToUInt16(bytes, at); }
    private static uint U32(byte[] bytes, int at) { Bounds(bytes, at, 4); return BitConverter.ToUInt32(bytes, at); }
    private static void Bounds(byte[] bytes, int at, int size) { if (at < 0 || size < 0 || at > bytes.Length - size) throw new InvalidDataException("Invalid binary offset."); }
    private static string CString(byte[] bytes, int at)
    {
        Bounds(bytes, at, 1); int end = at;
        while (end < bytes.Length && bytes[end] != 0 && end - at < 4096) end++;
        if (end == bytes.Length || end - at == 4096) throw new InvalidDataException("Unterminated binary string.");
        return Encoding.ASCII.GetString(bytes, at, end - at);
    }
    private static int PeOffset(byte[] bytes)
    {
        if (U16(bytes, 0) != 0x5a4d) throw new InvalidDataException("Not a PE file.");
        int offset = checked((int)U32(bytes, 0x3c));
        if (U32(bytes, offset) != 0x00004550) throw new InvalidDataException("Invalid PE signature.");
        return offset;
    }
    public static int Machine(byte[] bytes) { return U16(bytes, PeOffset(bytes) + 4); }
    private static int MapRva(byte[] bytes, uint rva, int sections, int count)
    {
        for (int i = 0; i < count; i++)
        {
            int at = sections + i * 40; uint start = U32(bytes, at + 12), rawSize = U32(bytes, at + 16);
            if (rva >= start && (ulong)rva - start < rawSize)
                return checked((int)((ulong)U32(bytes, at + 20) + rva - start));
        }
        throw new InvalidDataException("PE RVA does not resolve to file data.");
    }
    public static string[] Exports(byte[] bytes)
    {
        int pe = PeOffset(bytes), optional = pe + 24, size = U16(bytes, pe + 20);
        int directories = optional + (U16(bytes, optional) == 0x20b ? 112 : 96), count = U16(bytes, pe + 6), sections = optional + size;
        uint exportRva = U32(bytes, directories); if (exportRva == 0) return new string[0];
        int table = MapRva(bytes, exportRva, sections, count);
        uint namesCount = U32(bytes, table + 24); if (namesCount > 4096) throw new InvalidDataException("Too many exports.");
        int names = MapRva(bytes, U32(bytes, table + 32), sections, count);
        List<string> result = new List<string>();
        for (int i = 0; i < namesCount; i++)
        {
            string name = CString(bytes, MapRva(bytes, U32(bytes, names + i * 4), sections, count));
            // SfxCA leaves unused custom-action export slots with empty names.
            if (name.Length > 0) result.Add(name);
        }
        return result.ToArray();
    }

    public sealed class Cabinet
    {
        public byte[] Bytes { get; internal set; }
        public string[] Files { get; internal set; }
    }
    public static Cabinet ReadSfxCabinet(byte[] bytes)
    {
        return ReadSfxCabinet(bytes, "SusuClash.Installer.dll");
    }
    public static Cabinet ReadSfxCabinet(byte[] bytes, string managedName)
    {
        Cabinet result = null;
        for (int at = 0; at < bytes.Length - 36; at++)
        {
            if (bytes[at] != 77 || bytes[at + 1] != 83 || bytes[at + 2] != 67 || bytes[at + 3] != 70) continue;
            try
            {
                int size = checked((int)U32(bytes, at + 8)), filesAt = checked((int)U32(bytes, at + 16));
                int filesCount = U16(bytes, at + 28), flags = U16(bytes, at + 30);
                if (size < 36 || size > bytes.Length - at || filesAt < 36 || filesAt >= size || filesCount == 0 || filesCount > 128 || (flags & 3) != 0) continue;
                List<string> files = new List<string>(); int entry = at + filesAt;
                for (int i = 0; i < filesCount; i++)
                {
                    Bounds(bytes, entry, 17); string name = CString(bytes, entry + 16);
                    if (String.IsNullOrEmpty(name) || name.IndexOfAny(new char[] { '/', '\\', ':' }) >= 0 || name == "." || name == "..") throw new InvalidDataException("Unsafe cabinet filename.");
                    entry += 17 + Encoding.ASCII.GetByteCount(name); if (entry > at + size) throw new InvalidDataException("Cabinet file table outside archive.");
                    files.Add(name);
                }
                if (!files.Contains(managedName)) continue;
                if (result != null) throw new InvalidDataException("Multiple embedded managed UI cabinets.");
                byte[] cab = new byte[size]; Buffer.BlockCopy(bytes, at, cab, 0, size);
                result = new Cabinet { Bytes = cab, Files = files.ToArray() };
            }
            catch (OverflowException) { }
        }
        if (result == null) throw new InvalidDataException("Managed UI cabinet not found.");
        return result;
    }
}
