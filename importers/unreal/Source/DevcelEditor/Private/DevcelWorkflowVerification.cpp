// Integration verification for the actual UE runtime reader. Run with the documented UE automation command.
#if WITH_DEV_AUTOMATION_TESTS
#include "DevcelDataAsset.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Interfaces/IPluginManager.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDevcelWorkflowVerification, "Devcel.Integration.FullLoadIsolationReload",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDevcelWorkflowVerification::RunTest(const FString& Parameters)
{
    auto Plugin = IPluginManager::Get().FindPlugin(TEXT("Devcel"));
    if (!Plugin) { AddError(TEXT("Devcel plugin is not installed.")); return false; }
    FString Json, Error;
    if (!FFileHelper::LoadFileToString(Json, *FPaths::Combine(Plugin->GetBaseDir(), TEXT("Tests/fixtures/master.full.json"))))
    { AddError(TEXT("Canonical integration fixture is missing.")); return false; }
    auto* Base = NewObject<UDevcelDataAsset>(); auto* Event = NewObject<UDevcelDataAsset>();
    Base->SourceId = TEXT("base"); Event->SourceId = TEXT("event");
    TestTrue(TEXT("Full source loads"), Base->ReplaceJson(Json, Error));
    TestTrue(TEXT("Identical UUID source loads separately"), Event->ReplaceJson(Json, Error));
    FDevcelValue V;
    TestTrue(TEXT("I64 lookup"), Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("wide"), V, Error));
    TestEqual(TEXT("I64 precision > 2^53"), V.SignedInteger, int64(9007199254740993LL));
    uint64 Unsigned;
    TestTrue(TEXT("U64 lookup"), Base->GetUnsignedInteger(TEXT("Heroes"), TEXT("hero-1"), TEXT("huge"), Unsigned, Error));
    TestEqual(TEXT("U64 max is exact"), Unsigned, MAX_uint64);
    TestTrue(TEXT("ColorFloat lookup"), Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("color_float"), V, Error));
    TestEqual(TEXT("Negative RGB retained"), V.ColorFloat.R, -.25f); TestEqual(TEXT("HDR RGB retained"), V.ColorFloat.G, 2.f);
    TestEqual(TEXT("Transparent straight-alpha RGB retained"), V.ColorFloat.A, 0.f);
    TestTrue(TEXT("Color32 lookup"), Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("color32"), V, Error));
    TestEqual(TEXT("Color32 exact channels"), V.Color32, FColor(18,171,239,0));
    FString Table, Row;
    TestTrue(TEXT("Record reference resolves"), Base->ResolveReference(TEXT("Heroes"), TEXT("hero-1"), TEXT("item"), Table, Row, Error));
    TestEqual(TEXT("Reference target"), Row, FString(TEXT("item-1")));
    TestTrue(TEXT("Interface TableRef resolves"), Base->ResolveTableReference(TEXT("Heroes"), TEXT("hero-1"), TEXT("drops"), Table, Error));
    double Sample;
    TestTrue(TEXT("Curve sample"), Base->SampleCurve(TEXT("Heroes"), TEXT("hero-1"), TEXT("growth"), .5, Sample, Error));
    TestEqual(TEXT("Constant boundary switches segment"), Sample, 5.0);
    TestTrue(TEXT("Configured empty curve sample"), Base->SampleCurve(TEXT("Heroes"), TEXT("hero-1"), TEXT("empty_curve"), .5, Sample, Error));
    TestTrue(TEXT("Configured curve midpoint"), FMath::IsNearlyEqual(Sample, 3.0, 1.e-8));
    const int64 Revision = Base->GetRevision();
    Error = TEXT("previous failure");
    TestTrue(TEXT("Identical accepted JSON succeeds"), Base->ReplaceJson(Json, Error));
    TestTrue(TEXT("Unchanged replacement clears old error"), Error.IsEmpty());
    TestEqual(TEXT("Unchanged replacement keeps revision"), Base->GetRevision(), Revision);
    TestFalse(TEXT("Bad replacement rejected"), Base->ReplaceJson(TEXT("{\"tables\":[]}"), Error));
    TestEqual(TEXT("Failed replacement keeps revision"), Base->GetRevision(), Revision);
    TestTrue(TEXT("Old source still readable"), Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("wide"), V, Error));
    TestEqual(TEXT("Old value retained"), V.SignedInteger, int64(9007199254740993LL));
    const FString Updated = Json.Replace(TEXT("9007199254740993"), TEXT("9007199254740995"));
    TestTrue(TEXT("Validated replacement succeeds"), Base->ReplaceJson(Updated, Error));
    Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("wide"), V, Error);
    TestEqual(TEXT("New lookups see new snapshot"), V.SignedInteger, int64(9007199254740995LL));
    Event->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("wide"), V, Error);
    TestEqual(TEXT("Other source unchanged"), V.SignedInteger, int64(9007199254740993LL));
    Base->RestoreAfterFailedSave(Json, Revision);
    TestEqual(TEXT("Failed publication restores exact prior revision"), Base->GetRevision(), Revision);
    TestTrue(TEXT("Restored snapshot reloads"), Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("wide"), V, Error));
    TestEqual(TEXT("Failed publication restores prior value"), V.SignedInteger, int64(9007199254740993LL));
    // Exercise minimal defaults through the same real parser.
    TSharedPtr<FJsonObject> Minimal; FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Minimal);
    Minimal->GetObjectField(TEXT("manifest"))->SetStringField(TEXT("mode"), TEXT("minimal"));
    auto Hero = Minimal->GetArrayField(TEXT("tables"))[0]->AsObject()->GetArrayField(TEXT("records"))[0]->AsObject();
    Hero->GetObjectField(TEXT("values"))->RemoveField(TEXT("color_float"));
    FString MinimalJson; FJsonSerializer::Serialize(Minimal.ToSharedRef(), TJsonWriterFactory<>::Create(&MinimalJson));
    TestTrue(TEXT("Minimal loads defaults"), Base->ReplaceJson(MinimalJson, Error));
    Base->GetValue(TEXT("Heroes"), TEXT("hero-1"), TEXT("color_float"), V, Error);
    TestEqual(TEXT("Minimal HDR default retained"), V.ColorFloat.G, 2.f);
    auto HeroRows = Minimal->GetArrayField(TEXT("tables"))[0]->AsObject()->GetArrayField(TEXT("records"));
    for (const auto& Item : HeroRows)
    {
        auto Values = Item->AsObject()->GetObjectField(TEXT("values"));
        Values->RemoveField(TEXT("growth")); Values->RemoveField(TEXT("color_float"));
    }
    FString DefaultJson; FJsonSerializer::Serialize(Minimal.ToSharedRef(), TJsonWriterFactory<>::Create(&DefaultJson));
    TestTrue(TEXT("Repeated mutable defaults load"), Base->ReplaceJson(DefaultJson, Error));
    for (const TCHAR* Id : {TEXT("hero-1"), TEXT("hero-2")})
    {
        TestTrue(TEXT("Default curve lookup"), Base->SampleCurve(TEXT("Heroes"), Id, TEXT("growth"), .5, Sample, Error));
        TestEqual(TEXT("Default curve value retained"), Sample, 5.0);
        TestTrue(TEXT("Default color lookup"), Base->GetValue(TEXT("Heroes"), Id, TEXT("color_float"), V, Error));
        TestEqual(TEXT("Default color remains unchanged"), V.ColorFloat.G, 2.f);
        V.ColorFloat.G = 999.f;
    }
    TestFalse(TEXT("U64 overflow rejects all data"), Base->ReplaceJson(Json.Replace(TEXT("18446744073709551615"), TEXT("18446744073709551616")), Error));
    TestFalse(TEXT("Bad color rejects all data"), Base->ReplaceJson(Json.Replace(TEXT("[-0.25,2.0,0.5,0.0]"), TEXT("[-0.25,2.0,0.5,2.0]")), Error));
    return !HasAnyErrors();
}
#endif
