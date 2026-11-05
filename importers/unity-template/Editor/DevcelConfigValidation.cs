using System;
using System.IO;

namespace Devcel.Unity.Editor
{
    internal static class DevcelConfigValidation
    {
        private const string Keywords = " abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while ";
        internal static bool IsKeyword(string value) => Keywords.Contains(" " + value + " ");
        internal static bool Identifier(string value)
        {
            if (string.IsNullOrEmpty(value) || IsKeyword(value) || !(char.IsLetter(value[0]) || value[0] == '_')) return false;
            foreach (char c in value) if (!(char.IsLetterOrDigit(c) || c == '_')) return false;
            return true;
        }
        private const string PortableKeywords = " alignas alignof and and_eq asm auto bitand bitor char8_t char16_t char32_t compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast export friend inline mutable noexcept not not_eq nullptr or or_eq register reinterpret_cast requires signed static_assert static_cast template thread_local typedef typeid typename union unsigned wchar_t xor xor_eq ";
        internal static bool ClassName(string value) => Identifier(value) &&
            System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z_][A-Za-z0-9_]*$") &&
            !value.Contains("__") && !System.Text.RegularExpressions.Regex.IsMatch(value, "^_[A-Z]") &&
            !PortableKeywords.Contains(" " + value + " ");
        internal static bool FileName(string value) => !string.IsNullOrWhiteSpace(value) && value != "." && value != ".." &&
            value.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && value.IndexOfAny("<>:\"/\\|?*".ToCharArray()) < 0 &&
            !value.EndsWith(".", StringComparison.Ordinal) && !value.EndsWith(" ", StringComparison.Ordinal);
        private static StringComparison PathComparison => Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        private static bool SamePath(string left, string right) => string.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), PathComparison);

        /// <summary>Validates only saved numeric/environment settings, regardless of whether the CLI/source exists.</summary>
        internal static bool ValidateEnvironments(DevcelProjectConfig project, DevcelEnvironment? selectedEnvironment, out string error)
        {
            error = null;
            if (project == null || project.environments == null)
            { error = "No environment settings are available."; return false; }
            var environments = new System.Collections.Generic.HashSet<DevcelEnvironment>();
            foreach (var version in project.environments)
            {
                if (version == null)
                { error = "Environment settings contain null."; return false; }
                if (version.contentVersion < -1 || version.contentVersion > uint.MaxValue)
                { error = "Version must be -1 (all records) or 0..4294967295."; return false; }
                if (!environments.Add(version.environment))
                { error = "Duplicate environment settings: " + version.environment; return false; }
            }
            if (selectedEnvironment.HasValue && !environments.Contains(selectedEnvironment.Value))
            {
                error = "Selected environment " + selectedEnvironment.Value + " has no version setting. Explicitly specify -1 even when including all records.";
                return false;
            }
            return true;
        }

        internal static bool Validate(DevcelProjectConfig project, DevcelImporterSettings settings, out string error)
        {
            error = null;
            try
            {
                if (project == null || !System.Text.RegularExpressions.Regex.IsMatch(project.projectName ?? "", "^[A-Za-z0-9_-]+$")) error = "Source ID must contain only letters, digits, underscores, or hyphens.";
                else if (string.IsNullOrWhiteSpace(project.devcelProjectPath)) error = "Specify a devcelproj path.";
                else if (!FileName(project.bundleFileName) || !project.bundleFileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) error = "The bundle name must be a .json filename without a directory.";
                if (error != null) return false;
                string source = DevcelPaths.ResolveFromProjectRoot(project.devcelProjectPath);
                if (Directory.Exists(source))
                {
                    int count = Directory.GetFiles(source, "*.devcelproj.toml", SearchOption.TopDirectoryOnly).Length;
                    if (count != 1) error = "The selected directory must contain exactly one .devcelproj.toml file. If there are multiple files, select the file directly.";
                }
                else if (!File.Exists(source) || !source.EndsWith(".devcelproj.toml", StringComparison.OrdinalIgnoreCase))
                    error = "Specify an existing .devcelproj.toml file or a directory containing one.";
                string code = DevcelPaths.ToAbsolute(project.GetCodeOutputFolder());
                string assets = Path.GetFullPath(UnityEngine.Application.dataPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!code.StartsWith(assets, PathComparison) && !SamePath(code, UnityEngine.Application.dataPath)) error = "The generated code output must be under Assets in this Unity project.";
                foreach (var part in project.GetNamespace().Split('.'))
                    if (!Identifier(part)) { error = "Each namespace component must be a C# identifier that is not a reserved keyword."; break; }
                if (!ClassName(project.GetClassName())) error = "The root class name must be a single identifier containing letters, digits, or underscores, excluding reserved keywords and identifiers.";
                if (error != null) return false;
                if (!ValidateEnvironments(project, settings != null ? settings.activeEnvironment : (DevcelEnvironment?)null, out error)) return false;
                string bundle = Path.Combine(DevcelPaths.ToAbsolute(project.GetJsonOutputFolder()), project.bundleFileName);
                if (settings != null)
                    foreach (var other in settings.projects)
                    {
                        if (other == null || ReferenceEquals(project, other)) continue;
                        if (string.Equals(other.projectName, project.projectName, StringComparison.OrdinalIgnoreCase)) error = "Duplicate project name.";
                        else if (other.GetNamespace() == project.GetNamespace()) error = "The generated namespace conflicts with another project.";
                        else if (SamePath(DevcelPaths.ToAbsolute(other.GetCodeOutputFolder()), code)) error = "The code output path conflicts with another project.";
                        else if (SamePath(Path.Combine(DevcelPaths.ToAbsolute(other.GetJsonOutputFolder()), other.bundleFileName), bundle)) error = "The bundle output path conflicts with another project.";
                        if (error != null) return false;
                    }
                return true;
            }
            catch (Exception ex) { error = "Cannot validate the configured paths: " + ex.Message; return false; }
        }
    }
}
