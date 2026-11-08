#include "DevcelImporter.h"
#include "DevcelDataAsset.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformFileManager.h"
#include "GenericPlatform/GenericPlatformFile.h"
#include "HAL/PlatformTime.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/PackageName.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectIterator.h"
#include <cmath>
#include <cstdio>
#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#endif
#if PLATFORM_UNIX || PLATFORM_MAC
#include <sys/stat.h>
#endif

DEFINE_LOG_CATEGORY_STATIC(LogDevcelImport, Log, All);
namespace
{
bool Fail(FString& Error, const FString& Message) { Error = Message; return false; }
bool SafeId(const FString& Value)
{
    if (Value.IsEmpty()) return false;
    for (TCHAR C : Value) if (!((C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') || (C >= '0' && C <= '9') || C == '_' || C == '-')) return false;
    return true;
}
bool Identifier(const FString& Value)
{
    if (!SafeId(Value) || Value.Contains(TEXT("-")) || (Value[0] >= '0' && Value[0] <= '9')) return false;
    return true;
}
bool Namespace(const FString& Value)
{
    FString Canonical = Value.Replace(TEXT("::"), TEXT(".")); TArray<FString> Parts;
    Canonical.ParseIntoArray(Parts, TEXT("."), false);
    if (Parts.IsEmpty()) return false;
    for (const auto& Part : Parts) if (!Identifier(Part)) return false;
    return true;
}
bool Version(const FString& Text, uint32& Out)
{
    if (Text.IsEmpty()) return false;
    uint64 Number = 0;
    for (TCHAR C : Text) { if (C < '0' || C > '9') return false; Number = Number * 10 + C - '0'; if (Number > MAX_uint32) return false; }
    Out = uint32(Number); return true;
}
FString Quote(const FString& Value)
{
    // No shell is used. Paths containing quotes/control characters are rejected before launch.
    return TEXT("\"") + Value + TEXT("\"");
}
bool SafeArgument(const FString& Value) { return !Value.Contains(TEXT("\"")) && !Value.Contains(TEXT("\n")) && !Value.Contains(TEXT("\r")); }
bool ReadJson(const FString& Path, TSharedPtr<FJsonObject>& Out)
{
    FString Text; return FFileHelper::LoadFileToString(Text, *Path) && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Out) && Out;
}
bool AtomicReplace(const FString& Destination, const FString& Temporary)
{
#if PLATFORM_WINDOWS
    return ::MoveFileExW(*Temporary, *Destination, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#elif PLATFORM_UNIX || PLATFORM_MAC
    FTCHARToUTF8 From(*Temporary), To(*Destination);
    return ::rename(From.Get(), To.Get()) == 0;
#else
    return false; // Never emulate replace by deleting the destination first.
#endif
}
bool AtomicJson(const FString& Path, const TSharedRef<FJsonObject>& Json, FString& Error)
{
    FString Text; if (!FJsonSerializer::Serialize(Json, TJsonWriterFactory<>::Create(&Text))) return Fail(Error, TEXT("Could not serialize settings."));
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
    const FString Temporary = Path + TEXT(".") + FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".tmp");
    if (!FFileHelper::SaveStringToFile(Text, *Temporary, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return Fail(Error, TEXT("Could not write settings: ") + Temporary);
    if (!AtomicReplace(Path, Temporary))
    { IFileManager::Get().Delete(*Temporary); return Fail(Error, TEXT("Could not replace settings; check write permission/source control: ") + Path); }
    return true;
}
bool NoSymlink(const FString& Path, FString& Error)
{
    FString Current = FPaths::ConvertRelativePathToFull(Path);
    while (!Current.IsEmpty())
    {
        if (FPlatformFileManager::Get().GetPlatformFile().IsSymlink(*Current) == ESymlinkResult::Symlink) return Fail(Error, TEXT("Symlink/junction paths are not supported: ") + Current);
        FString Parent = FPaths::GetPath(Current); if (Parent == Current) break; Current = Parent;
    }
    return true;
}
FString EditorSettingsPath() { return FPaths::Combine(FDevcelImporter::ConfigDirectory(), TEXT("DevcelEditor.json")); }
}
FString FDevcelImporter::ConfigDirectory() { return FPaths::ConvertRelativePathToFull(FPaths::ProjectConfigDir()); }
FString FDevcelImporter::ConfigPath() { return FPaths::Combine(ConfigDirectory(), TEXT("Devcel.import.json")); }
FString FDevcelImporter::RuntimePath(const FDevcelImportSource& Source) { return FPaths::ConvertRelativePathToFull(ConfigDirectory(), Source.RuntimeOut); }
FString FDevcelImporter::AssetPath(const FDevcelImportSource& Source) { return TEXT("/Game/Devcel/") + Source.Id + TEXT("/Database"); }
FDevcelImporter::FDevcelImporter()
{
    TSharedPtr<FJsonObject> Prefs; if (ReadJson(EditorSettingsPath(), Prefs)) Prefs->TryGetBoolField(TEXT("auto_import"), bAuto);
    Refresh(); NextPoll = FPlatformTime::Seconds() + 5;
}
FDevcelImporter::~FDevcelImporter() { Shutdown(); }
void FDevcelImporter::DiscardSaveInput() { if (!SaveInputPath.IsEmpty()) { IFileManager::Get().Delete(*SaveInputPath); SaveInputPath.Reset(); } }
void FDevcelImporter::Shutdown()
{
    if (Process)
    {
        // Mutating CLI operations must finish their commit/rollback before we destroy the monitor.
        // Force-killing in the publication window can leave a mixed generation on disk.
        if (Operation == EOperation::Save || Operation == EOperation::Pull)
        {
            UE_LOG(LogDevcelImport, Display, TEXT("Waiting for the current Devcel transaction before closing the Editor."));
            while (Process->Update()) FPlatformProcess::Sleep(.05f);
        }
        else Process->Cancel(true);
        Process.Reset();
    }
    DiscardSaveInput();
}
bool FDevcelImporter::Refresh()
{
    if (IsBusy()) return false;
    Sources.Reset(); Config.Reset();
    if (!IFileManager::Get().FileExists(*ConfigPath()))
    { Config = MakeShared<FJsonObject>(); Config->SetNumberField(TEXT("schema_version"), 1); Config->SetArrayField(TEXT("sources"), {}); return true; }
    if (!ReadJson(ConfigPath(), Config)) { Status = TEXT("Settings JSON is unreadable. It has not been replaced: ") + ConfigPath(); return false; }
    const TArray<TSharedPtr<FJsonValue>>* Array; double Schema;
    if (!Config->TryGetNumberField(TEXT("schema_version"), Schema) || Schema != 1 || !Config->TryGetArrayField(TEXT("sources"), Array))
    { Status = TEXT("Settings require schema_version 1 and sources array."); Config.Reset(); return false; }
    for (const auto& Value : *Array)
    {
        if (!Value || Value->Type != EJson::Object) { Status = TEXT("Invalid source settings."); Config.Reset(); Sources.Reset(); return false; }
        auto O = Value->AsObject(); FDevcelImportSource S;
        if (!O->TryGetStringField(TEXT("id"), S.Id) || !O->TryGetStringField(TEXT("project"), S.Project) ||
            !O->TryGetStringField(TEXT("namespace"), S.Namespace) || !O->TryGetStringField(TEXT("runtime_out"), S.RuntimeOut))
        { Status = TEXT("Source requires id/project/namespace/runtime_out."); Config.Reset(); Sources.Reset(); return false; }
        O->TryGetStringField(TEXT("class_name"), S.ClassName); O->TryGetStringField(TEXT("mode"), S.Mode);
        if (O->HasField(TEXT("row_include_tags")) && !O->TryGetStringArrayField(TEXT("row_include_tags"), S.row_include_tags))
        { Status = TEXT("row_include_tags must be a string array."); Config.Reset(); Sources.Reset(); return false; }
        if (O->HasField(TEXT("row_exclude_tags")) && !O->TryGetStringArrayField(TEXT("row_exclude_tags"), S.row_exclude_tags))
        { Status = TEXT("row_exclude_tags must be a string array."); Config.Reset(); Sources.Reset(); return false; }
        if (O->HasField(TEXT("column_include_tags")) && !O->TryGetStringArrayField(TEXT("column_include_tags"), S.column_include_tags))
        { Status = TEXT("column_include_tags must be a string array."); Config.Reset(); Sources.Reset(); return false; }
        if (O->HasField(TEXT("column_exclude_tags")) && !O->TryGetStringArrayField(TEXT("column_exclude_tags"), S.column_exclude_tags))
        { Status = TEXT("column_exclude_tags must be a string array."); Config.Reset(); Sources.Reset(); return false; }
        auto VersionValue = O->TryGetField(TEXT("version"));
        if (VersionValue && VersionValue->Type != EJson::Null)
        {
            double Number;
            if (!VersionValue->TryGetNumber(Number) || !std::isfinite(Number) || std::floor(Number) != Number || Number < 0 || Number > MAX_uint32)
            { Status = TEXT("ContentVersion must be empty or 0..4294967295."); Config.Reset(); Sources.Reset(); return false; }
            S.Version = FString::Printf(TEXT("%.0f"), Number);
        }
        // This native reader does not own existing generated-code outputs.
        if (O->HasField(TEXT("code_out")) && O->TryGetField(TEXT("code_out"))->Type != EJson::Null)
        { Status = TEXT("Use a dedicated UE settings file; code_out is not supported by this native-reader importer."); Config.Reset(); Sources.Reset(); return false; }
        Sources.Add(S);
    }
    return true;
}
bool FDevcelImporter::RelativeProject(FString& Path, FString& Error)
{
    Path = FPaths::ConvertRelativePathToFull(ConfigDirectory(), Path); FPaths::NormalizeFilename(Path);
    if (!Path.EndsWith(TEXT(".devcelproj.toml")) || !IFileManager::Get().FileExists(*Path)) return Fail(Error, TEXT("Choose an existing .devcelproj.toml file."));
    if (!SafeArgument(Path)) return Fail(Error, TEXT("Source paths cannot contain quotes or line breaks."));
    if (!NoSymlink(Path, Error)) return false;
    FString Base = ConfigDirectory() + TEXT("/");
    if (!FPaths::MakePathRelativeTo(Path, *Base) || !FPaths::IsRelative(Path)) return Fail(Error, TEXT("Source must be on the same volume, so its path can be saved relative to Config/."));
    return true;
}
bool FDevcelImporter::ValidateSource(const FDevcelImportSource& S, const FString& OriginalId, FString& Error) const
{
    if (!SafeId(S.Id)) return Fail(Error, TEXT("Source ID must contain ASCII letters, digits, _ or -."));
    if (!OriginalId.IsEmpty() && S.Id != OriginalId) return Fail(Error, TEXT("Source ID is stable; add a new source to change it."));
    if (!Namespace(S.Namespace) || !Identifier(S.ClassName)) return Fail(Error, TEXT("Namespace/class name must be valid ASCII identifiers."));
    if (S.Mode != TEXT("full") && S.Mode != TEXT("minimal")) return Fail(Error, TEXT("Mode must be full/minimal."));
    uint32 V; if (!S.Version.IsEmpty() && !Version(S.Version, V)) return Fail(Error, TEXT("ContentVersion must be empty or 0..4294967295; 0 is valid."));
    FString Project = S.Project;
    if (!RelativeProject(Project, Error)) return false;
    // Dedicated importer-owned output avoids arbitrary files/assets and is excluded from cook.
    const FString Expected = TEXT("../Intermediate/Devcel/") + S.Id + TEXT("/master.json");
    if (!S.RuntimeOut.IsEmpty() && S.RuntimeOut != Expected) return Fail(Error, TEXT("UE runtime_out must be ") + Expected);
    int32 OwnCount = 0;
    const FString Ns = S.Namespace.Replace(TEXT("::"), TEXT(".")).ToLower();
    for (const auto& Other : Sources)
    {
        if (Other.Id == OriginalId) { if (++OwnCount > 1) return Fail(Error, TEXT("Duplicate source ID in settings.")); continue; }
        const FString OtherNs = Other.Namespace.Replace(TEXT("::"), TEXT(".")).ToLower();
        if (Other.Id.Equals(S.Id, ESearchCase::IgnoreCase)) return Fail(Error, TEXT("Duplicate source ID."));
        if (OtherNs == Ns || OtherNs.StartsWith(Ns + TEXT(".")) || Ns.StartsWith(OtherNs + TEXT("."))) return Fail(Error, TEXT("Duplicate/overlapping source namespace."));
    }
    return NoSymlink(FPaths::ConvertRelativePathToFull(ConfigDirectory(), Expected), Error) && NoSymlink(ConfigPath(), Error);
}
bool FDevcelImporter::SaveSource(const FDevcelImportSource& Draft, const FString& OriginalId, FString& Error)
{
    if (IsBusy()) return Fail(Error, TEXT("Wait for the current import."));
    if (!Refresh() || !Config) return Fail(Error, Status);
    if (!ValidateSource(Draft, OriginalId, Error)) return false;
    if (!OriginalId.IsEmpty() && !Sources.ContainsByPredicate([&](const auto& S){ return S.Id == OriginalId; })) return Fail(Error, TEXT("Edited source was removed. Reopen the wizard."));
    FDevcelImportSource S = Draft;
    if (!RelativeProject(S.Project, Error)) return false;
    S.RuntimeOut = TEXT("../Intermediate/Devcel/") + S.Id + TEXT("/master.json");
    auto Source = MakeShared<FJsonObject>(); Source->SetStringField(TEXT("id"), S.Id); Source->SetStringField(TEXT("project"), S.Project);
    Source->SetStringField(TEXT("namespace"), S.Namespace); Source->SetStringField(TEXT("class_name"), S.ClassName);
    Source->SetStringField(TEXT("runtime_out"), S.RuntimeOut); Source->SetStringField(TEXT("mode"), S.Mode);
    uint32 V; if (!S.Version.IsEmpty() && Version(S.Version, V)) Source->SetNumberField(TEXT("version"), V);
    Source->SetStringArrayField(TEXT("row_include_tags"), S.row_include_tags);
    Source->SetStringArrayField(TEXT("row_exclude_tags"), S.row_exclude_tags);
    Source->SetStringArrayField(TEXT("column_include_tags"), S.column_include_tags);
    Source->SetStringArrayField(TEXT("column_exclude_tags"), S.column_exclude_tags);

    TArray<TSharedPtr<FJsonValue>> Array;
    for (const auto& Item : Config->GetArrayField(TEXT("sources")))
        if (Item->AsObject()->GetStringField(TEXT("id")) != OriginalId) Array.Add(Item);
    Array.Add(MakeShared<FJsonValueObject>(Source));
    Config->SetArrayField(TEXT("sources"), Array);
    // The shared CLI validates the whole candidate and atomically saves under its config lock.
    // Its --input is temporary; paths inside the JSON are resolved against the final --config.
    if (!PrepareCli(Error)) { Refresh(); return false; }
    StartConfigText.Reset();
    if (IFileManager::Get().FileExists(*ConfigPath()) && !FFileHelper::LoadFileToString(StartConfigText, *ConfigPath()))
        return Fail(Error, TEXT("Could not read existing settings."));
    SaveInputPath = FPaths::Combine(ConfigDirectory(), TEXT(".devcel-candidate-") + FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".json"));
    if (!SafeArgument(ConfigPath()) || !SafeArgument(SaveInputPath) || !AtomicJson(SaveInputPath, Config.ToSharedRef(), Error))
    { SaveInputPath.Reset(); Refresh(); return false; }
    PendingSource = S.Id; bStatusOnly = false; bStopRequested = false;
    if (!Launch(EOperation::Help)) { IFileManager::Get().Delete(*SaveInputPath); SaveInputPath.Reset(); Error = Status; return false; }
    return true;
}
void FDevcelImporter::SetAuto(bool Value)
{
    auto Prefs = MakeShared<FJsonObject>(); Prefs->SetBoolField(TEXT("auto_import"), Value); FString Error;
    if (!AtomicJson(EditorSettingsPath(), Prefs, Error)) { Status = Error; return; }
    bAuto = Value; NextPoll = FPlatformTime::Seconds() + 5;
}
bool FDevcelImporter::PrepareCli(FString& Error)
{
    auto Plugin = IPluginManager::Get().FindPlugin(TEXT("Devcel"));
    if (!Plugin) return Fail(Error, TEXT("Devcel plugin directory was not found."));
    FString Rid;
#if PLATFORM_WINDOWS && !PLATFORM_CPU_ARM_FAMILY
    Rid = TEXT("win-x64");
#elif PLATFORM_MAC && PLATFORM_CPU_ARM_FAMILY
    Rid = TEXT("osx-arm64");
#elif PLATFORM_LINUX && !PLATFORM_CPU_ARM_FAMILY
    Rid = TEXT("linux-x64");
#else
    return Fail(Error, TEXT("No bundled CLI for this Editor OS/CPU."));
#endif
    const FString Tools = FPaths::ConvertRelativePathToFull(FPaths::Combine(Plugin->GetBaseDir(), TEXT("Tools")));
    const FString ManifestPath = FPaths::Combine(Tools, TEXT("manifest.json"));
    TSharedPtr<FJsonObject> Manifest;
    if (!NoSymlink(ManifestPath, Error) || !ReadJson(ManifestPath, Manifest)) return Fail(Error, TEXT("Bundled CLI manifest missing/unsafe. Install the matching OS/CPU importer ZIP. ") + Error);
    const TSharedPtr<FJsonObject> *Binaries, *Binary; TArray<FString> Platforms; double Schema; FString Relative, Hash;
    if (!Manifest->TryGetNumberField(TEXT("schema_version"), Schema) || Schema != 1 ||
        !Manifest->TryGetStringArrayField(TEXT("supportedPlatforms"), Platforms) || !Platforms.Contains(Rid) ||
        !Manifest->TryGetObjectField(TEXT("binaries"), Binaries) || !(*Binaries)->TryGetObjectField(Rid, Binary) ||
        !(*Binary)->TryGetStringField(TEXT("path"), Relative) || !(*Binary)->TryGetStringField(TEXT("sha256"), Hash)) return Fail(Error, TEXT("Bundled CLI manifest does not match this OS/CPU."));
    const FString Expected = Rid + TEXT("/devcel") + (PLATFORM_WINDOWS ? TEXT(".exe") : TEXT(""));
    if (Relative != Expected || Hash.Len() != 64) return Fail(Error, TEXT("Invalid bundled CLI path/hash."));
    Cli = FPaths::Combine(Tools, Relative);
    if (!SafeArgument(Cli) || !NoSymlink(Cli, Error)) return false;
    TArray<uint8> Bytes; FSHA256Signature Digest;
    if (!FFileHelper::LoadFileToArray(Bytes, *Cli) || !FPlatformMisc::GetSHA256Signature(Bytes.GetData(), Bytes.Num(), Digest) || !BytesToHex(Digest.Signature, 32).Equals(Hash, ESearchCase::IgnoreCase))
        return Fail(Error, TEXT("Bundled CLI SHA-256 verification failed. Reinstall the matching importer ZIP."));
#if PLATFORM_UNIX || PLATFORM_MAC
    FTCHARToUTF8 Filename(*Cli); struct stat Info;
    if (stat(Filename.Get(), &Info) != 0 || !S_ISREG(Info.st_mode) || (!(Info.st_mode & S_IXUSR) && chmod(Filename.Get(), Info.st_mode | S_IXUSR) != 0))
        return Fail(Error, TEXT("Cannot restore owner-execute permission on verified bundled CLI."));
#endif
    return true;
}
bool FDevcelImporter::Import(const FString& Id, bool StatusOnly)
{
    if (IsBusy()) return false;
    if (!Refresh() || Sources.IsEmpty()) return false;
    for (const auto& Source : Sources) { FString Error; if (!ValidateSource(Source, Source.Id, Error)) { Status = Error; return false; } }
    if (!Id.IsEmpty() && !Sources.ContainsByPredicate([&](const auto& S){ return S.Id == Id; })) { Status = TEXT("Unknown source ID."); return false; }
    FString Error;
    if (!PrepareCli(Error) || !SafeArgument(ConfigPath())) { Status = Error; UE_LOG(LogDevcelImport, Error, TEXT("%s"), *Status); return false; }
    if (!FFileHelper::LoadFileToString(StartConfigText, *ConfigPath())) { Status = TEXT("Could not snapshot current settings."); return false; }
    PendingSource = Id; bStatusOnly = StatusOnly; bStopRequested = false;
    return Launch(EOperation::Help);
}
bool FDevcelImporter::RequestTagPresets(const FString& Project, TFunction<void(bool, const TArray<FString>&)> Callback)
{
    if (IsBusy()) return false;
    FString Error;
    TagProject = FPaths::ConvertRelativePathToFull(ConfigDirectory(), Project);
    if (!SafeArgument(TagProject) || !PrepareCli(Error)) { Status = Error; return false; }
    TagCallback = MoveTemp(Callback);
    return Launch(EOperation::Tags);
}
bool FDevcelImporter::Launch(EOperation Next)
{
    Operation = Next; FString Args;
    if (Next == EOperation::Tags) Args = TEXT("tag-presets --mode local --project ") + Quote(TagProject);
    else if (Next == EOperation::Help) Args = TEXT("pull --help");
    else if (Next == EOperation::Save)
    {
        FString Current;
        FFileHelper::LoadFileToString(Current, *ConfigPath());
        if (Current != StartConfigText)
        { IFileManager::Get().Delete(*SaveInputPath); SaveInputPath.Reset(); Status = TEXT("Settings changed before save. Reopen the wizard; no settings were overwritten."); return false; }
        Args = TEXT("pull-config-save --config ") + Quote(ConfigPath()) + TEXT(" --input ") + Quote(SaveInputPath);
    }
    else
    {
        Args = TEXT("pull --config ") + Quote(ConfigPath());
        if (!PendingSource.IsEmpty()) Args += TEXT(" --source ") + Quote(PendingSource);
        if (Next == EOperation::Status) Args += TEXT(" --status");
    }
    Output = MakeShared<FOutput, ESPMode::ThreadSafe>(); auto Buffer = Output;
    Process = MakeUnique<FMonitoredProcess>(Cli, Args, ConfigDirectory(), true, true);
    Process->OnOutput().BindLambda([Buffer](FString Line)
    {
        FScopeLock Lock(&Buffer->Mutex);
        if (Buffer->Text.Len() + Line.Len() > 8 * 1024 * 1024) Buffer->Truncated = true;
        else Buffer->Text += Line + TEXT("\n");
    });
    StartedAt = FPlatformTime::Seconds();
    if (!Process->Launch()) { Process.Reset(); DiscardSaveInput(); Status = TEXT("Could not start bundled CLI. Check OS security prompts manually; security warnings are never bypassed."); return false; }
    Status = Next == EOperation::Pull ? TEXT("Importing saved source…") : TEXT("Checking bundled CLI / saved source…"); return true;
}
void FDevcelImporter::Cancel()
{
    bAuto = false; SetAuto(false);
    if (Process && (Operation == EOperation::Save || Operation == EOperation::Pull))
    {
        bStopRequested = true;
        Status = TEXT("Stopping after the current CLI transaction finishes safely. Auto is off; no further asset publication will run.");
        return;
    }
    if (Process) { Process->Cancel(true); Process.Reset(); }
    DiscardSaveInput();
    Status = TEXT("Import stopped. Existing assets are preserved; use Reimport to resume.");
}
bool FDevcelImporter::Tick(float Delta)
{
    if (Process)
    {
        if ((Operation == EOperation::Help || Operation == EOperation::Tags) && FPlatformTime::Seconds() - StartedAt > 15)
        { Cancel(); Status = TEXT("Read-only CLI probe timed out after 15 seconds. Existing assets were not published."); return true; }
        if (!Process->Update())
        {
            int32 Exit = Process->GetReturnCode(); Process.Reset();
            FString Text; bool Truncated;
            { FScopeLock Lock(&Output->Mutex); Text = Output->Text; Truncated = Output->Truncated; }
            if (bStopRequested)
            {
                bStopRequested = false; DiscardSaveInput(); Refresh();
                Status = TEXT("Stopped at a safe transaction boundary. Settings/CLI output may have completed; previous runtime assets were retained. Reimport when ready.");
            }
            else if (Truncated) { DiscardSaveInput(); Status = TEXT("CLI output exceeded the safety limit; no assets published."); NextPoll = FPlatformTime::Seconds() + 30; }
            else Complete(Exit, Text);
        }
    }
    else if (bAuto && FPlatformTime::Seconds() >= NextPoll)
    {
        NextPoll = FPlatformTime::Seconds() + 5;
        Import(FString(), true);
    }
    return true;
}
void FDevcelImporter::Complete(int32 Exit, const FString& Text)
{
    if (Operation == EOperation::Tags)
    {
        TSharedPtr<FJsonObject> Root;
        TArray<FString> Presets;
        const TSharedPtr<FJsonObject>* Data = nullptr;
        bool Ok = false;
        bool Success = Exit == 0 && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) && Root.IsValid() &&
            Root->TryGetBoolField(TEXT("ok"), Ok) && Ok && Root->TryGetObjectField(TEXT("data"), Data) &&
            (*Data)->TryGetStringArrayField(TEXT("presets"), Presets);
        Status = Success ? TEXT("Project tag presets loaded.") : TEXT("Cannot load project tag presets. Existing filters are retained.");
        auto Callback = MoveTemp(TagCallback);
        if (Callback) Callback(Success, Presets);
        return;
    }
    NextPoll = FPlatformTime::Seconds() + 5;
    if (Exit != 0 && (Operation == EOperation::Help || Operation == EOperation::Save)) { DiscardSaveInput(); Refresh(); Status = FString::Printf(TEXT("CLI failed (%d). Previous assets retained.\n%s"), Exit, *Text); UE_LOG(LogDevcelImport, Error, TEXT("%s"), *Status); NextPoll += 25; return; }
    if (Operation == EOperation::Help)
    {
        if (!Text.Contains(TEXT("--config")) || !Text.Contains(TEXT("--source")) || !Text.Contains(TEXT("--status"))) { DiscardSaveInput(); Status = TEXT("Bundled CLI lacks required pull commands."); return; }
        Launch(!SaveInputPath.IsEmpty() ? EOperation::Save : bStatusOnly ? EOperation::Status : EOperation::Pull); return;
    }
    if (Operation == EOperation::Save)
    {
        IFileManager::Get().Delete(*SaveInputPath); SaveInputPath.Reset();
        TSharedPtr<FJsonObject> Root; const TSharedPtr<FJsonObject>* Data; bool Ok = false, Saved = false;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root || !Root->TryGetBoolField(TEXT("ok"), Ok) || !Ok ||
            !Root->TryGetObjectField(TEXT("data"), Data) || !(*Data)->TryGetBoolField(TEXT("saved"), Saved) || !Saved)
        { Status = TEXT("Settings save did not return a valid success result. Reopen the importer to inspect settings.\n") + Text; return; }
        if (!Refresh() || !FFileHelper::LoadFileToString(StartConfigText, *ConfigPath())) return;
        Launch(EOperation::Pull); return;
    }
    FString CurrentSettings;
    if (!FFileHelper::LoadFileToString(CurrentSettings, *ConfigPath()) || CurrentSettings != StartConfigText)
    { Status = TEXT("Settings changed during import; assets were not published. Reimport using the current settings."); return; }
    TSharedPtr<FJsonObject> Root; bool Ok = false;
    const TSharedPtr<FJsonObject>* Data; const TArray<TSharedPtr<FJsonValue>>* Reports;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root || !Root->TryGetBoolField(TEXT("ok"), Ok) ||
        !Root->TryGetObjectField(TEXT("data"), Data) || !(*Data)->TryGetArrayField(TEXT("sources"), Reports))
    { Status = TEXT("CLI returned no valid success envelope; previous assets retained.\n") + Text; return; }
    bool NeedsPull = false; int32 Count = 0; FString Errors = (!Ok || Exit != 0) ? TEXT("Some sources failed; successful sources are handled independently.\n") : FString();
    for (const auto& Report : *Reports)
    {
        if (!Report || Report->Type != EJson::Object) { Errors += TEXT("Invalid source report.\n"); continue; }
        FString Id, State; auto O = Report->AsObject();
        if (!O->TryGetStringField(TEXT("id"), Id) || !O->TryGetStringField(TEXT("status"), State)) { Errors += TEXT("Missing source status.\n"); continue; }
        if (State == TEXT("needs_pull")) { NeedsPull = true; continue; }
        if (State != TEXT("ready") && State != TEXT("pulled")) { NeedsPull = true; Errors += Id + TEXT(": source error.\n"); continue; }
        const auto* Source = Sources.FindByPredicate([&](const auto& S){ return S.Id == Id; });
        if (!Source) { Errors += TEXT("Unknown source in CLI result.\n"); continue; }
        FString Error;
        // A ready CLI output may still need asset publication after a prior save failure.
        if (Publish(*Source, Error)) ++Count; else Errors += Id + TEXT(": ") + Error + TEXT("\n");
    }
    if (Operation == EOperation::Status && NeedsPull && bAuto)
    { Launch(EOperation::Pull); return; }
    Status = FString::Printf(TEXT("%d source(s) ready. %s"), Count, NeedsPull ? TEXT("Saved source changed; press Reimport.") : TEXT("Runtime assets updated."));
    if (!Errors.IsEmpty()) { Status += TEXT("\n") + Errors + TEXT("Fix the save/collision error, then Reimport. The last valid asset is retained."); UE_LOG(LogDevcelImport, Error, TEXT("%s"), *Status); NextPoll += 25; }
}
bool FDevcelImporter::Publish(const FDevcelImportSource& Source, FString& Error)
{
    FString Json;
    if (!FFileHelper::LoadFileToString(Json, *RuntimePath(Source))) return Fail(Error, TEXT("Could not read CLI runtime output."));
    UDevcelDataAsset* Probe = NewObject<UDevcelDataAsset>();
    if (!Probe->ReplaceJson(Json, Error, false)) return false;
    const FString PackageName = AssetPath(Source), Name = FPaths::GetCleanFilename(PackageName);
    const FString Filename = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
    if (!NoSymlink(Filename, Error)) return false;
    const FString ObjectPath = PackageName + TEXT(".") + Name;
    const FString Owner = TEXT("Config/Devcel.import.json#") + Source.Id;
    UObject* Existing = LoadObject<UObject>(nullptr, *ObjectPath);
    UDevcelDataAsset* Asset = Cast<UDevcelDataAsset>(Existing);
    const bool ExistsOnDisk = IFileManager::Get().FileExists(*Filename);
    if ((Existing && !Asset) || (!Existing && ExistsOnDisk) || (Asset && Asset->ImportOwner != Owner))
        return Fail(Error, TEXT("Refusing to overwrite an existing, unreadable, or differently owned asset: ") + ObjectPath);
    if (Asset && Asset->GetCanonicalJson() == Json && Asset->CodeNamespace == Source.Namespace && Asset->ClassName == Source.ClassName) return true;
    if (ExistsOnDisk && IFileManager::Get().IsReadOnly(*Filename)) return Fail(Error, TEXT("Check out/make the owned asset writable before reimport: ") + Filename);
    UPackage* Package = Asset ? Asset->GetOutermost() : CreatePackage(*PackageName);
    if (Package->IsDirty()) return Fail(Error, TEXT("Asset/package has unsaved edits. Save or discard them first: ") + PackageName);
    const bool Created = !Asset;
    if (!Asset) Asset = NewObject<UDevcelDataAsset>(Package, *Name, RF_Public | RF_Standalone);
    const int64 OldRevision = Asset->GetRevision();
    FString OldJson = Asset->GetCanonicalJson(), OldId = Asset->SourceId, OldNamespace = Asset->CodeNamespace, OldClass = Asset->ClassName, OldOwner = Asset->ImportOwner;
    Asset->SourceId = Source.Id; Asset->CodeNamespace = Source.Namespace; Asset->ClassName = Source.ClassName; Asset->ImportOwner = Owner;
    if (!Asset->ReplaceJson(Json, Error, false)) return false;
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
    const FString Temporary = Filename + TEXT(".") + FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".uasset");
    FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone; Args.SaveFlags = SAVE_NoError;
    bool Saved = UPackage::SavePackage(Package, Asset, *Temporary, Args);
    if (Saved) Saved = AtomicReplace(Filename, Temporary);
    if (!Saved)
    {
        IFileManager::Get().Delete(*Temporary);
        if (Created) { Asset->ClearFlags(RF_Public | RF_Standalone); Asset->MarkAsGarbage(); }
        else { Asset->RestoreAfterFailedSave(OldJson, OldRevision); Asset->SourceId = OldId; Asset->CodeNamespace = OldNamespace; Asset->ClassName = OldClass; Asset->ImportOwner = OldOwner; }
        Package->SetDirtyFlag(false);
        return Fail(Error, TEXT("Could not publish asset (read-only/source control/disk space). CLI JSON is ready; retry Reimport after fixing it."));
    }
    Package->SetDirtyFlag(false);
    if (Created) FAssetRegistryModule::AssetCreated(Asset);
    Asset->NotifyReloaded();
    // PIE can hold duplicated assets. Update matching instances only after disk publication succeeds.
    for (TObjectIterator<UDevcelDataAsset> It; It; ++It)
        if (*It != Asset && !It->IsTemplate() && It->GetOutermost()->HasAnyPackageFlags(PKG_PlayInEditor) && It->ImportOwner == Owner && It->SourceId == Source.Id)
        { FString ReloadError; It->ReplaceJson(Json, ReloadError); }
    return true;
}
