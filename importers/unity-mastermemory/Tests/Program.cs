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
            row.Value_f32 != 1.5f || !row.Value_boolean || row.Value_color != "[255,0,1,255]")
            throw new Exception("Generated values differ");
        var item = db.DevcelRow_itemsTable.FindByRecordId("00000000-0000-4000-8000-000000000002");
        if (item.Value_quantity != 17) throw new Exception("Second table differs");
        for (int i = 1; i < args.Length; i++)
        {
            try { BuildData.FromJson(File.ReadAllText(args[i])); throw new Exception("Invalid bundle accepted: " + args[i]); }
            catch (FormatException) { }
        }
        Console.WriteLine("MASTERMEMORY_GENERATED_PASS");
    }
}
