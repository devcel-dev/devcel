using System;
using System.IO;
using DevcelMasterMemory;

class Program
{
    static void Main(string[] args)
    {
        var data = BuildData.FromJson(File.ReadAllText(args[0]));
        var db = new DevcelMemoryDatabase(data);
        var row = db.DevcelRow_enemiesTable.FindByRecordId("00000000-0000-4000-8000-000000000001");
        if (row.Value_name != "Enemy 1" || row.Value_i8 != -7 || row.Value_u64 != ulong.MaxValue ||
            row.Value_f32 != 1.5f || !row.Value_boolean || row.Value_color.R != 255 || row.Value_color.B != 1 || row.Value_color.A != 255 || row.Value_hdr.R != 2 || row.Value_hdr.G != -1 || row.Value_hdr.A != 0 || Math.Abs(row.Value_curve.Sample(0.5) - 0.5) > 1e-9)
            throw new Exception("Generated values differ");
        if (Math.Abs(row.Value_curve2.Sample(0.15) - 1.002585613171157) > 1e-12 ||
            Math.Abs(row.Value_curve2.Sample(0.55) - 1.437342524517376) > 1e-12 ||
            row.Value_curve2.Sample(0.85) != 2.0)
            throw new Exception("Curve disagrees with Devcel runtime");
        var item = db.DevcelRow_itemsTable.FindByRecordId("00000000-0000-4000-8000-000000000002");
        if (item.Value_quantity != 17 || row.Value_item.Resolve(db) != item || row.Value_table.As_items(db) != db.DevcelRow_itemsTable)
            throw new Exception("Typed references differ");
        for (int i = 0; i < 10000; i++) { row.Value_item.Resolve(db); row.Value_curve.Sample(0.5); }
        long start = GC.GetAllocatedBytesForCurrentThread();
        for (int i = 0; i < 100000; i++) { row.Value_item.Resolve(db); row.Value_curve.Sample(0.5); }
        if (GC.GetAllocatedBytesForCurrentThread() != start) throw new Exception("Typed reads allocated");
        string livePath = Path.Combine(Path.GetDirectoryName(args[0]), "live-test.json");
        string original = File.ReadAllText(args[0]);
        File.WriteAllText(livePath, original);
        using (var live = new LiveDatabase(data, livePath))
        {
            var oldRow = live.Current.DevcelRow_enemiesTable.FindByRecordId("00000000-0000-4000-8000-000000000001");
            File.WriteAllText(livePath, original.Replace("Enemy 1", "Enemy updated"));
            if (LiveDatabase.ReloadOpenDatabases(livePath) != 1 || live.Version != 1 ||
                live.Current.DevcelRow_enemiesTable.FindByRecordId(oldRow.RecordId).Value_name != "Enemy updated" || oldRow.Value_name != "Enemy 1")
                throw new Exception("Live replacement or snapshot semantics failed");
            File.WriteAllText(livePath, File.ReadAllText(args[1]));
            try { LiveDatabase.ReloadOpenDatabases(livePath); throw new Exception("Invalid reload accepted"); }
            catch (FormatException) { }
            if (live.Version != 1 || live.Current.DevcelRow_enemiesTable.FindByRecordId(oldRow.RecordId).Value_name != "Enemy updated")
                throw new Exception("Failed reload replaced the live database");
        }
        if (LiveDatabase.ReloadOpenDatabases(livePath) != 0) throw new Exception("Disposed database was reloaded");
        for (int i = 1; i < args.Length; i++)
        {
            try { BuildData.FromJson(File.ReadAllText(args[i])); throw new Exception("Invalid bundle accepted: " + args[i]); }
            catch (FormatException) { }
        }
        Console.WriteLine("MASTERMEMORY_GENERATED_PASS");
    }
}
