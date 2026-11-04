#include "DevcelImporter.h"
#include "DesktopPlatformModule.h"
#include "IDesktopPlatform.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
FText Txt(const FString& Text) { return FText::FromString(Text); }
FString Signature(const FDevcelImportSource& S)
{ return S.Id + TEXT("\n") + S.Project + TEXT("\n") + S.Namespace + TEXT("\n") + S.ClassName + TEXT("\n") + S.RuntimeOut + TEXT("\n") + S.Version + TEXT("\n") + S.Mode + TEXT("\nrow_include_tags:") + FString::Join(S.row_include_tags, TEXT("\n")) + TEXT("\nrow_exclude_tags:") + FString::Join(S.row_exclude_tags, TEXT("\n")) + TEXT("\ncolumn_include_tags:") + FString::Join(S.column_include_tags, TEXT("\n")) + TEXT("\ncolumn_exclude_tags:") + FString::Join(S.column_exclude_tags, TEXT("\n")); }

class SDevcelWizard : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SDevcelWizard) {} SLATE_ARGUMENT(TSharedPtr<FDevcelImporter>, Importer) SLATE_ARGUMENT(FDevcelImportSource, Source) SLATE_ARGUMENT(FString, OriginalId) SLATE_END_ARGS()
    void Construct(const FArguments& Args)
    {
        Importer = Args._Importer; Draft = Args._Source; OriginalId = Args._OriginalId; OriginalSignature = Signature(Draft);
        ChildSlot [ SNew(SScrollBox) + SScrollBox::Slot() [ SAssignNew(Body, SVerticalBox) ] ]; Rebuild();
    }
private:
    TSharedPtr<FDevcelImporter> Importer;
    FDevcelImportSource Draft;
    FString OriginalId, OriginalSignature, Error;
    TSharedPtr<SVerticalBox> Body;
    int32 Step = 0;
    bool Completed = false;
    void Field(const FString& Label, FString& Value, bool Enabled = true)
    {
        FString* Ptr = &Value;
        Body->AddSlot().AutoHeight().Padding(0, 5) [ SNew(STextBlock).Text(Txt(Label)) ];
        Body->AddSlot().AutoHeight() [ SNew(SEditableTextBox).Text(Txt(Value)).IsEnabled_Lambda([this, Enabled]{return Enabled && !Importer->IsBusy() && !Completed;})
            .OnTextChanged_Lambda([Ptr](const FText& Text){ *Ptr = Text.ToString(); }) ];
    }
    TArray<FString> Presets;
    void LoadTagPresets()
    {
                    TWeakPtr<SDevcelWizard> Weak = SharedThis(this);
                    const FString RequestedProject = Draft.Project;
                    if (!Importer->RequestTagPresets(RequestedProject, [Weak, RequestedProject](bool Success, const TArray<FString>& Tags){
                        if (auto Widget = Weak.Pin()) { if (Widget->Draft.Project != RequestedProject) return; Widget->Presets = Tags; Widget->Error = Success ? FString() : TEXT("Cannot load project presets. Existing filters retained."); Widget->Rebuild(); }
                    })) Error = Importer->GetStatus();
    }
    void TagField(const FString& Label, TArray<FString>& Values)
    {
        auto* Tags = &Values;
        Body->AddSlot().AutoHeight() [ SNew(STextBlock).Text(Txt(Label)) ];
        for (int32 Index = 0; Index < Values.Num(); ++Index)
        {
            Body->AddSlot().AutoHeight() [ SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1) [ SNew(SEditableTextBox).Text(Txt(Values[Index]))
                    .OnTextChanged_Lambda([Tags, Index](const FText& Value){ (*Tags)[Index] = Value.ToString(); }) ]
                + SHorizontalBox::Slot().AutoWidth() [ SNew(SButton).Text(Txt(TEXT("Remove")))
                    .OnClicked_Lambda([this, Tags, Index]{Tags->RemoveAt(Index); Rebuild(); return FReply::Handled();}) ] ];
            if (!Presets.Contains(Values[Index])) Body->AddSlot().AutoHeight() [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Unregistered tag: edit to a project preset or explicitly remove it."))) ];
        }
        auto Choices = SNew(SHorizontalBox);
        for (const FString& Preset : Presets)
            Choices->AddSlot().AutoWidth().Padding(2) [ SNew(SCheckBox).IsChecked(Values.Contains(Preset) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked)
                .OnCheckStateChanged_Lambda([this, Tags, Preset](ECheckBoxState State){ if (State == ECheckBoxState::Checked) Tags->AddUnique(Preset); else Tags->Remove(Preset); Rebuild(); })
                [ SNew(STextBlock).Text(Txt(Preset)) ] ];
        Body->AddSlot().AutoHeight() [ Choices ];
    }
    void Rebuild()
    {
        Body->ClearChildren();
        const TCHAR* Titles[] = {TEXT("1. Choose source"), TEXT("2. Import settings"), TEXT("3. Review and import")};
        Body->AddSlot().AutoHeight().Padding(0, 0, 0, 12) [ SNew(STextBlock).Text(Txt(Titles[Step])) ];
        if (Step == 0)
        {
            Field(TEXT("Source ID (stable, unique within this title)"), Draft.Id, OriginalId.IsEmpty());
            Field(TEXT("Saved .devcelproj.toml (relative to the title's Config folder)"), Draft.Project);
            Body->AddSlot().AutoHeight().Padding(0, 6) [ SNew(SButton).Text(Txt(TEXT("Browse…"))).IsEnabled_Lambda([this]{return !Importer->IsBusy() && !Completed;})
                .OnClicked_Lambda([this]
                {
                    if (auto* Desktop = FDesktopPlatformModule::Get())
                    {
                        TArray<FString> Files;
                        void* Parent = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared());
                        if (Desktop->OpenFileDialog(Parent, TEXT("Choose Devcel project"), FDevcelImporter::ConfigDirectory(), TEXT(""), TEXT("Devcel project|*.devcelproj.toml"), 0, Files) && Files.Num() == 1)
                        { Draft.Project = Files[0]; FDevcelImporter::RelativeProject(Draft.Project, Error); Rebuild(); }
                    }
                    else Error = TEXT("Native file dialogs are unavailable; enter the project path above.");
                    return FReply::Handled();
                }) ];
            Body->AddSlot().AutoHeight().Padding(0, 6) [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Only saved files are imported. Copies with identical project/table/row UUIDs remain separate sources."))) ];
        }
        else if (Step == 1)
        {
            Field(TEXT("Namespace (for example Game.Master; unique per source)"), Draft.Namespace);
            Field(TEXT("Class name (source metadata; native access uses UDevcelDataAsset)"), Draft.ClassName);
            Field(TEXT("ContentVersion (empty = all; 0..4294967295)"), Draft.Version);
            Body->AddSlot().AutoHeight() [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Tag filters apply only to this source. Empty includes select all; includes match any tag; excludes win."))) ];
            Body->AddSlot().AutoHeight() [ SNew(SButton).Text(Txt(TEXT("Refresh project tag presets"))).IsEnabled_Lambda([this]{return !Importer->IsBusy();})
                .OnClicked_Lambda([this]{
                    LoadTagPresets();
                    return FReply::Handled();
                }) ];
            TagField(TEXT("row include tags"), Draft.row_include_tags);
            TagField(TEXT("row exclude tags"), Draft.row_exclude_tags);
            TagField(TEXT("column include tags"), Draft.column_include_tags);
            TagField(TEXT("column exclude tags"), Draft.column_exclude_tags);

            Body->AddSlot().AutoHeight().Padding(0, 8) [ SNew(SCheckBox).IsChecked(Draft.Mode == TEXT("minimal") ? ECheckBoxState::Checked : ECheckBoxState::Unchecked)
                .OnCheckStateChanged_Lambda([this](ECheckBoxState State){Draft.Mode = State == ECheckBoxState::Checked ? TEXT("minimal") : TEXT("full");})
                [ SNew(STextBlock).Text(Txt(TEXT("Minimal JSON (omitted values are restored from defaults at load)"))) ] ];
            Body->AddSlot().AutoHeight().Padding(0, 6) [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Every source is loaded completely into memory. The CLI stays in the Editor; cooked games use the generated Data Asset."))) ];
        }
        else
        {
            FString Review = TEXT("Source: ") + Draft.Id + TEXT("\nProject: ") + Draft.Project + TEXT("\nNamespace: ") + Draft.Namespace +
                TEXT("\nClass name: ") + Draft.ClassName + TEXT("\nContentVersion: ") + (Draft.Version.IsEmpty() ? TEXT("All") : Draft.Version) +
                TEXT("\nMode: ") + Draft.Mode + TEXT("\nAsset: ") + FDevcelImporter::AssetPath(Draft) +
                TEXT("\n\nSettings are saved in Config/Devcel.import.json. Reimport updates only this source. Existing unrelated assets are never replaced.");
            Review += TEXT("\nrow_include_tags: ") + FString::Join(Draft.row_include_tags, TEXT(", "));
            Review += TEXT("\nrow_exclude_tags: ") + FString::Join(Draft.row_exclude_tags, TEXT(", "));
            Review += TEXT("\ncolumn_include_tags: ") + FString::Join(Draft.column_include_tags, TEXT(", "));
            Review += TEXT("\ncolumn_exclude_tags: ") + FString::Join(Draft.column_exclude_tags, TEXT(", "));
            Body->AddSlot().AutoHeight() [ SNew(STextBlock).AutoWrapText(true).Text(Txt(Review)) ];
        }
        Body->AddSlot().FillHeight(1).Padding(0, 12) [ SNew(SScrollBox) + SScrollBox::Slot() [ SNew(STextBlock).AutoWrapText(true)
            .Text_Lambda([this]{return Txt(Error.IsEmpty() ? (Completed ? Importer->GetStatus() : FString()) : Error);}) ] ];
        auto Buttons = SNew(SHorizontalBox);
        Buttons->AddSlot().AutoWidth().Padding(0, 0, 6, 0) [ SNew(SButton).Text(Txt(TEXT("Back"))).IsEnabled_Lambda([this]{return Step > 0 && !Completed && !Importer->IsBusy();})
            .OnClicked_Lambda([this]{ --Step; if (Step == 0) Presets.Reset(); Error.Reset(); Rebuild(); return FReply::Handled(); }) ];
        Buttons->AddSlot().FillWidth(1) [ SNew(SButton).Text(Txt(Step < 2 ? TEXT("Next") : TEXT("Save and Import")))
            .IsEnabled_Lambda([this]{return !Completed && !Importer->IsBusy();})
            .OnClicked_Lambda([this]
            {
                Error.Reset();
                if (Step == 0)
                {
                    if (Draft.Id.IsEmpty()) Error = TEXT("Enter a source ID.");
                    else if (FDevcelImporter::RelativeProject(Draft.Project, Error)) { ++Step; Rebuild(); LoadTagPresets(); }
                }
                else if (Step == 1)
                {
                    if (Importer->ValidateSource(Draft, OriginalId, Error)) { ++Step; Rebuild(); }
                }
                else
                {
                    if (!Importer->Refresh()) { Error = Importer->GetStatus(); return FReply::Handled(); }
                    if (!OriginalId.IsEmpty())
                    {
                        const auto* Current = Importer->GetSources().FindByPredicate([this](const auto& S){return S.Id == OriginalId;});
                        if (!Current || Signature(*Current) != OriginalSignature) { Error = TEXT("This source changed while the wizard was open. Close and reopen it before saving."); return FReply::Handled(); }
                    }
                    if (Importer->SaveSource(Draft, OriginalId, Error)) Completed = true;
                }
                return FReply::Handled();
            }) ];
        Buttons->AddSlot().AutoWidth().Padding(6, 0, 0, 0) [ SNew(SButton).Text_Lambda([this]{return Txt(Completed ? TEXT("Close (import continues)") : TEXT("Cancel"));}).OnClicked_Lambda([this]
        { auto Window = FSlateApplication::Get().FindWidgetWindow(AsShared()); if (Window) Window->RequestDestroyWindow(); return FReply::Handled(); }) ];
        Body->AddSlot().AutoHeight() [ Buttons ];
    }
};
void Wizard(const TSharedPtr<FDevcelImporter>& Importer, const FDevcelImportSource* Existing)
{
    FDevcelImportSource Draft; FString Original;
    if (Existing) { Draft = *Existing; Original = Draft.Id; }
    else
    {
        int32 N = 1; Draft.Id = TEXT("master");
        while (Importer->GetSources().ContainsByPredicate([&](const auto& S){return S.Id.Equals(Draft.Id, ESearchCase::IgnoreCase);})) Draft.Id = TEXT("master") + FString::FromInt(++N);
        Draft.Namespace = TEXT("Game.") + Draft.Id;
    }
    auto Window = SNew(SWindow).Title(Txt(TEXT("Devcel Setup Wizard"))).ClientSize(FVector2D(680, 540)).SupportsMaximize(false).SupportsMinimize(false);
    Window->SetContent(SNew(SBorder).Padding(18) [ SNew(SDevcelWizard).Importer(Importer).Source(Draft).OriginalId(Original) ]);
    FSlateApplication::Get().AddWindow(Window);
}
class SDevcelManager : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SDevcelManager) {} SLATE_ARGUMENT(TSharedPtr<FDevcelImporter>, Importer) SLATE_END_ARGS()
    void Construct(const FArguments& Args)
    {
        Importer = Args._Importer;
        ChildSlot [ SNew(SBorder).Padding(16) [ SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12) [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Import saved Devcel projects. Configure each source once, then Reimport here or use Auto import."))) ]
            + SVerticalBox::Slot().AutoHeight() [ SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0) [ SNew(SButton).Text(Txt(TEXT("Add Source…"))).IsEnabled_Lambda([this]{return !Importer->IsBusy();}).OnClicked_Lambda([this]{Wizard(Importer, nullptr); return FReply::Handled();}) ]
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0) [ SNew(SButton).Text(Txt(TEXT("Reimport All"))).IsEnabled_Lambda([this]{return !Importer->IsBusy();}).OnClicked_Lambda([this]{Importer->Import(); return FReply::Handled();}) ]
                + SHorizontalBox::Slot().AutoWidth() [ SNew(SButton).Text(Txt(TEXT("Stop Import"))).IsEnabled_Lambda([this]{return Importer->IsBusy();}).OnClicked_Lambda([this]{Importer->Cancel(); return FReply::Handled();}) ] ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 10) [ SNew(SCheckBox).IsChecked_Lambda([this]{return Importer->IsAuto() ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;})
                .OnCheckStateChanged_Lambda([this](ECheckBoxState State){Importer->SetAuto(State == ECheckBoxState::Checked);}) [ SNew(STextBlock).Text(Txt(TEXT("Auto import saved changes (every 5 seconds, including PIE)"))) ] ]
            + SVerticalBox::Slot().FillHeight(1) [ SNew(SScrollBox) + SScrollBox::Slot() [ SAssignNew(List, SVerticalBox) ] ]
            + SVerticalBox::Slot().FillHeight(.5f).Padding(0, 10) [ SNew(SScrollBox) + SScrollBox::Slot() [ SNew(STextBlock).AutoWrapText(true).Text_Lambda([this]{return Txt(Importer->GetStatus());}) ] ] ] ];
        Rebuild();
    }
    virtual void Tick(const FGeometry& Geometry, double Time, float Delta) override
    {
        SCompoundWidget::Tick(Geometry, Time, Delta);
        FString Current; for (const auto& S : Importer->GetSources()) Current += Signature(S);
        if (Current != LastSignature) { LastSignature = Current; Rebuild(); }
    }
private:
    TSharedPtr<FDevcelImporter> Importer; TSharedPtr<SVerticalBox> List; FString LastSignature;
    TArray<FString> Presets;
    void LoadTagPresets()
    {
                    TWeakPtr<SDevcelWizard> Weak = SharedThis(this);
                    const FString RequestedProject = Draft.Project;
                    if (!Importer->RequestTagPresets(RequestedProject, [Weak, RequestedProject](bool Success, const TArray<FString>& Tags){
                        if (auto Widget = Weak.Pin()) { if (Widget->Draft.Project != RequestedProject) return; Widget->Presets = Tags; Widget->Error = Success ? FString() : TEXT("Cannot load project presets. Existing filters retained."); Widget->Rebuild(); }
                    })) Error = Importer->GetStatus();
    }
    void TagField(const FString& Label, TArray<FString>& Values)
    {
        auto* Tags = &Values;
        Body->AddSlot().AutoHeight() [ SNew(STextBlock).Text(Txt(Label)) ];
        for (int32 Index = 0; Index < Values.Num(); ++Index)
        {
            Body->AddSlot().AutoHeight() [ SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1) [ SNew(SEditableTextBox).Text(Txt(Values[Index]))
                    .OnTextChanged_Lambda([Tags, Index](const FText& Value){ (*Tags)[Index] = Value.ToString(); }) ]
                + SHorizontalBox::Slot().AutoWidth() [ SNew(SButton).Text(Txt(TEXT("Remove")))
                    .OnClicked_Lambda([this, Tags, Index]{Tags->RemoveAt(Index); Rebuild(); return FReply::Handled();}) ] ];
            if (!Presets.Contains(Values[Index])) Body->AddSlot().AutoHeight() [ SNew(STextBlock).AutoWrapText(true).Text(Txt(TEXT("Unregistered tag: edit to a project preset or explicitly remove it."))) ];
        }
        auto Choices = SNew(SHorizontalBox);
        for (const FString& Preset : Presets)
            Choices->AddSlot().AutoWidth().Padding(2) [ SNew(SCheckBox).IsChecked(Values.Contains(Preset) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked)
                .OnCheckStateChanged_Lambda([this, Tags, Preset](ECheckBoxState State){ if (State == ECheckBoxState::Checked) Tags->AddUnique(Preset); else Tags->Remove(Preset); Rebuild(); })
                [ SNew(STextBlock).Text(Txt(Preset)) ] ];
        Body->AddSlot().AutoHeight() [ Choices ];
    }
    void Rebuild()
    {
        List->ClearChildren();
        for (const auto& S : Importer->GetSources())
        {
            const FString Id = S.Id;
            List->AddSlot().AutoHeight().Padding(0, 5) [ SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1) [ SNew(STextBlock).AutoWrapText(true).Text(Txt(Id + TEXT("\n") + S.Project + TEXT("\n") + S.Namespace + TEXT(" / ") + S.ClassName)) ]
                + SHorizontalBox::Slot().AutoWidth().Padding(5, 0) [ SNew(SButton).Text(Txt(TEXT("Edit…"))).IsEnabled_Lambda([this]{return !Importer->IsBusy();})
                    .OnClicked_Lambda([this, Id]{ const auto* Source = Importer->GetSources().FindByPredicate([&](const auto& X){return X.Id == Id;}); if (Source) Wizard(Importer, Source); return FReply::Handled();}) ]
                + SHorizontalBox::Slot().AutoWidth() [ SNew(SButton).Text(Txt(TEXT("Reimport"))).IsEnabled_Lambda([this]{return !Importer->IsBusy();})
                    .OnClicked_Lambda([this, Id]{Importer->Import(Id); return FReply::Handled();}) ] ];
        }
    }
};
}
void OpenDevcelWindow(const TSharedRef<FDevcelImporter>& Importer)
{
    static TWeakPtr<SWindow> Existing;
    if (auto Window = Existing.Pin()) { Window->BringToFront(); return; }
    Importer->Refresh();
    auto Window = SNew(SWindow).Title(FText::FromString(TEXT("Devcel Importer"))).ClientSize(FVector2D(760, 580));
    Window->SetContent(SNew(SDevcelManager).Importer(Importer)); Existing = Window;
    FSlateApplication::Get().AddWindow(Window);
}
