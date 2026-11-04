#include "DevcelImporter.h"
#include "Containers/Ticker.h"
#include "Modules/ModuleManager.h"
#include "ToolMenus.h"

class FDevcelEditorModule final : public IModuleInterface
{
    TSharedPtr<FDevcelImporter> Importer;
    FTSTicker::FDelegateHandle Ticker;
public:
    virtual bool SupportsDynamicReloading() override { return false; }
    virtual void StartupModule() override
    {
        if (IsRunningCommandlet()) return;
        Importer = MakeShared<FDevcelImporter>();
        Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateSP(Importer.ToSharedRef(), &FDevcelImporter::Tick), .2f);
        UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FDevcelEditorModule::RegisterMenus));
    }
    virtual void ShutdownModule() override
    {
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
        FTSTicker::GetCoreTicker().RemoveTicker(Ticker);
        if (Importer) Importer->Shutdown();
        Importer.Reset();
    }
    void RegisterMenus()
    {
        FToolMenuOwnerScoped Owner(this);
        UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
        Menu->FindOrAddSection(TEXT("Devcel")).AddMenuEntry(TEXT("DevcelImporter"), FText::FromString(TEXT("Devcel Importer")),
            FText::FromString(TEXT("Configure saved sources and reimport Devcel data.")), FSlateIcon(),
            FUIAction(FExecuteAction::CreateLambda([this] { if (Importer) OpenDevcelWindow(Importer.ToSharedRef()); })));
    }
};
IMPLEMENT_MODULE(FDevcelEditorModule, DevcelEditor)
