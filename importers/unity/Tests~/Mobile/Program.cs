using System;
namespace UnityEditor
{
    public enum BuildTarget { StandaloneLinux64, StandaloneWindows64, StandaloneOSX, Android, iOS, WebGL }
}
internal static class Program
{
    public static int Main(string[] args)
    {
        var target = (UnityEditor.BuildTarget)Enum.Parse(typeof(UnityEditor.BuildTarget), args[0]);
        bool valid = Devcel.Unity.Editor.DevcelNativeBinary.Validate(args[1], target, out string error);
        Console.WriteLine(valid ? "accepted" : error);
        return valid == bool.Parse(args[2]) ? 0 : 1;
    }
}
