using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using MasterMemory;
using MessagePack;
using Demo;

[assembly: MasterMemoryGeneratorOptions(Namespace = "Demo")]

[MemoryTable("enemies"), MessagePackObject(true)]
public class Enemy
{
    [PrimaryKey] public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

public static class Program
{
    public static void Main(string[] args)
    {
        if (args.Length != 1) throw new ArgumentException("Specify a Devcel full bundle JSON file");
        using var document = JsonDocument.Parse(File.ReadAllText(args[0]));
        var root = document.RootElement;
        if (root.GetProperty("manifest").GetProperty("schema_version").GetInt32() != 1 ||
            root.GetProperty("manifest").GetProperty("mode").GetString() != "full")
            throw new InvalidDataException("Expected a full v1 Devcel bundle");
        var table = root.GetProperty("tables").EnumerateArray().Single(t => t.GetProperty("name").GetString() == "enemies");
        var rows = table.GetProperty("records").EnumerateArray().Select(r => new Enemy {
            Id = r.GetProperty("id").GetString()!,
            Name = r.GetProperty("values").GetProperty("name").GetString()!
        }).ToArray();
        var builder = new DatabaseBuilder();
        builder.Append(rows);
        var database = new MemoryDatabase(builder.Build());
        foreach (var row in rows)
            if (database.EnemyTable.FindById(row.Id).Name != row.Name)
                throw new Exception("MasterMemory read did not match Devcel export");
        Console.WriteLine($"Read {rows.Length} enemies through MasterMemory");
    }
}
