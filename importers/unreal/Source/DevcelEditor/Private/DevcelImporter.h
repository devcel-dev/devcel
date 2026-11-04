#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Misc/MonitoredProcess.h"

struct FDevcelImportSource
{
    FString Id, Project, Namespace = TEXT("Game.Master"), ClassName = TEXT("MasterData"), RuntimeOut, Version;
    FString Mode = TEXT("full");
    TArray<FString> row_include_tags;
    TArray<FString> row_exclude_tags;
    TArray<FString> column_include_tags;
    TArray<FString> column_exclude_tags;

};

/** One process at a time, owned by the module rather than by a transient wizard window. */
class FDevcelImporter : public TSharedFromThis<FDevcelImporter>
{
public:
    FDevcelImporter();
    ~FDevcelImporter();
    bool Refresh();
    bool RequestTagPresets(const FString& Project, TFunction<void(bool, const TArray<FString>&)> Callback);
    bool SaveSource(const FDevcelImportSource& Draft, const FString& OriginalId, FString& Error);
    bool ValidateSource(const FDevcelImportSource& Draft, const FString& OriginalId, FString& Error) const;
    bool Import(const FString& SourceId = FString(), bool bStatusOnly = false);
    bool Tick(float Delta);
    void Cancel();
    void Shutdown();
    bool IsBusy() const { return Process.IsValid(); }
    bool IsAuto() const { return bAuto; }
    void SetAuto(bool bValue);
    const TArray<FDevcelImportSource>& GetSources() const { return Sources; }
    FString GetStatus() const { return Status; }
    static FString ConfigPath();
    static FString ConfigDirectory();
    static FString RuntimePath(const FDevcelImportSource& Source);
    static FString AssetPath(const FDevcelImportSource& Source);
    static bool RelativeProject(FString& Path, FString& Error);
private:
    enum class EOperation { Help, Save, Status, Pull, Tags };
    struct FOutput { FCriticalSection Mutex; FString Text; bool Truncated = false; };
    TArray<FDevcelImportSource> Sources;
    TSharedPtr<FJsonObject> Config;
    TUniquePtr<FMonitoredProcess> Process;
    TSharedPtr<FOutput, ESPMode::ThreadSafe> Output;
    FString Cli, PendingSource, Status, StartConfigText, SaveInputPath;
    FString TagProject;
    TFunction<void(bool, const TArray<FString>&)> TagCallback;
    EOperation Operation = EOperation::Help;
    bool bAuto = true, bStatusOnly = false, bStopRequested = false;
    double StartedAt = 0, NextPoll = 0;
    void DiscardSaveInput();
    bool PrepareCli(FString& Error);
    bool Launch(EOperation Next);
    void Complete(int32 Exit, const FString& Text);
    bool Publish(const FDevcelImportSource& Source, FString& Error);
};

void OpenDevcelWindow(const TSharedRef<FDevcelImporter>& Importer);
