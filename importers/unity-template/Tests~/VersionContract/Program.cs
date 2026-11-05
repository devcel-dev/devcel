using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using Devcel.Unity.Editor;
[DataContract]
sealed class Result
{
    [DataMember] public bool ok;
    [DataMember] public string value;
    [DataMember] public string error;
    [DataMember] public string exception;
}
static class Program
{
    static void Main(string[] args)
    {
        // Actual path/version/hash and CLI execution code is compiled unchanged.
        // Only the Unity host's package lookup and asset lookup are represented.
        string root = Path.GetFullPath(args[1]);
        UnityEditor.PackageManager.PackageInfo.Root = root;
        UnityEditor.PackageManager.PackageInfo.UseUpm = args[0] != "assets";
        UnityEngine.Application.dataPath = Path.Combine(args[2], "Assets");
        UnityEditor.AssetDatabase.ScriptPath = "Assets/DevcelUnity/Editor/DevcelPaths.cs";
        var result = new Result();
        try
        {
            switch (args[3])
            {
                case "prepare": result.value = DevcelPaths.PrepareCliPath(); result.ok = true; break;
                case "required": result.value = DevcelPaths.PackageVersion; result.ok = true; break;
                case "bundled": result.ok = DevcelCliRunner.ValidateBundledCli(out result.error); break;
                default: throw new ArgumentException("Unknown test action");
            }
        }
        catch (Exception ex) { result.exception = ex.GetType().FullName; result.error = ex.Message; }
        new DataContractJsonSerializer(typeof(Result)).WriteObject(Console.OpenStandardOutput(), result);
        Console.WriteLine();
    }
}
