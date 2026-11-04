#include "DevcelDataAsset.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Internationalization/Regex.h"
#include <cmath>
#include <limits>

namespace
{
struct FCurvePoint
{
    double X = 0, Y = 0, InSlope = 0, OutSlope = 0, InLen = 1, OutLen = 1;
    bool HasInSlope = false, HasOutSlope = false;
    FString Mode;
};
struct FColumn
{
    FString Type, Default, TargetUuid, InterfaceUuid;
    TSharedPtr<FJsonObject> CurveConfig;
    FDevcelValue DefaultValue;
    TArray<FCurvePoint> DefaultCurve;
};
struct FRow
{
    TMap<FString, FDevcelValue> Values;
    TMap<FString, TArray<FCurvePoint>> Curves;
};
struct FTable
{
    FString Name, Uuid;
    TArray<FString> Interfaces, Order;
    TMap<FString, FColumn> Columns;
    TMap<FString, FRow> Rows;
};
bool Fail(FString& Error, const FString& Message) { Error = Message; return false; }
bool Name(const TSharedPtr<FJsonObject>& Object, const TCHAR* Key, FString& Out)
{
    return Object && Object->TryGetStringField(Key, Out) && !Out.IsEmpty();
}
bool Number(const TSharedPtr<FJsonObject>& Object, const TCHAR* Key, double& Out)
{
    return Object && Object->TryGetNumberField(Key, Out) && std::isfinite(Out);
}
bool Whole(double X) { return std::isfinite(X) && std::floor(X) == X; }
bool Integer(const FString& Raw, bool bSigned, int32 Bits, FDevcelValue& Out)
{
    FString Text = Raw.TrimStartAndEnd();
    if (Text.IsEmpty()) Text = TEXT("0");
    int32 Index = 0;
    bool Negative = Text[0] == '-';
    if (Negative || Text[0] == '+') ++Index;
    if (Index == Text.Len()) return false;
    const uint64 Limit = bSigned ? (Negative ? (uint64(1) << (Bits - 1)) : ((uint64(1) << (Bits - 1)) - 1))
        : (Bits == 64 ? MAX_uint64 : ((uint64(1) << Bits) - 1));
    uint64 Magnitude = 0;
    for (; Index < Text.Len(); ++Index)
    {
        if (Text[Index] < '0' || Text[Index] > '9') return false;
        uint64 Digit = Text[Index] - '0';
        if (Magnitude > (Limit - Digit) / 10 || Digit > Limit) return false;
        Magnitude = Magnitude * 10 + Digit;
    }
    if (!bSigned && Negative && Magnitude != 0) return false;
    if (bSigned)
        Out.SignedInteger = Negative ? (Magnitude == (uint64(1) << 63) ? MIN_int64 : -int64(Magnitude)) : int64(Magnitude);
    else
    {
        Out.UnsignedInteger = Magnitude;
        Out.UnsignedDecimal = FString::Printf(TEXT("%llu"), static_cast<unsigned long long>(Magnitude));
    }
    return true;
}
bool DecodeColor(const FString& Text, bool bByte, FDevcelValue& Value, FString& Error)
{
    // Regex programs are immutable; only the matcher state belongs to this cell.
    static const FRegexPattern BytePattern(TEXT("^[ \\t\\r\\n]*\\[[ \\t\\r\\n]*(?:0|[1-9][0-9]*)(?:[ \\t\\r\\n]*,[ \\t\\r\\n]*(?:0|[1-9][0-9]*)){3}[ \\t\\r\\n]*\\][ \\t\\r\\n]*$"));
    static const FString FloatToken = TEXT("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?");
    static const FString Space = TEXT("[ \\t\\r\\n]*");
    static const FRegexPattern FloatPattern(TEXT("^") + Space + TEXT("\\[") + Space + FloatToken + TEXT("(?:") + Space + TEXT(",") + Space + FloatToken + TEXT("){3}") + Space + TEXT("\\]") + Space + TEXT("$"));
    FRegexMatcher Match(bByte ? BytePattern : FloatPattern, Text);
    TArray<TSharedPtr<FJsonValue>> Channels;
    if (!Match.FindNext() || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Channels) || Channels.Num() != 4)
        return Fail(Error, TEXT("Color requires four JSON numeric channels."));
    double C[4];
    for (int32 I = 0; I < 4; ++I)
    {
        if (!Channels[I]->TryGetNumber(C[I]) || !std::isfinite(C[I])) return Fail(Error, TEXT("Non-finite color channel."));
        if (bByte && (!Whole(C[I]) || C[I] < 0 || C[I] > 255)) return Fail(Error, TEXT("Color32 channel outside 0..255."));
        if (!bByte && (!std::isfinite(float(C[I])) || (I == 3 && (C[I] < 0 || C[I] > 1))))
            return Fail(Error, TEXT("ColorFloat requires finite F32 channels and alpha 0..1."));
    }
    if (bByte) Value.Color32 = FColor(uint8(C[0]), uint8(C[1]), uint8(C[2]), uint8(C[3]));
    else Value.ColorFloat = FLinearColor(float(C[0]), float(C[1]), float(C[2]), float(C[3]));
    return true;
}
bool DecodeCurve(const FString& Raw, const TSharedPtr<FJsonObject>& Config, TArray<FCurvePoint>& Points, FString& Error)
{
    double Start = 0, End = 1;
    if (Config && (!Number(Config, TEXT("start_value"), Start) || !Number(Config, TEXT("end_value"), End)))
        return Fail(Error, TEXT("Curve config requires finite start_value/end_value."));
    if (Raw.IsEmpty())
    {
        FCurvePoint A, B; A.X = 0; A.Y = Start; A.Mode = TEXT("auto"); B.X = 1; B.Y = End; B.Mode = TEXT("auto");
        Points = {A, B}; return true;
    }
    TSharedPtr<FJsonObject> Object;
    const TArray<TSharedPtr<FJsonValue>>* Items;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Raw), Object) || !Object ||
        !Object->TryGetArrayField(TEXT("points"), Items) || Items->Num() < 2) return Fail(Error, TEXT("Curve requires at least two points."));
    double Previous = -1;
    for (const auto& Item : *Items)
    {
        if (!Item || Item->Type != EJson::Object) return Fail(Error, TEXT("Invalid curve point."));
        auto P = Item->AsObject(); FCurvePoint Point;
        if (!Number(P, TEXT("x"), Point.X) || !Number(P, TEXT("y"), Point.Y) || Point.X <= Previous || Point.X > 1 ||
            Point.X < 0 || !Name(P, TEXT("mode"), Point.Mode)) return Fail(Error, TEXT("Curve points require ascending finite x/y."));
        if (Point.Mode != TEXT("constant") && Point.Mode != TEXT("linear") && Point.Mode != TEXT("auto") &&
            Point.Mode != TEXT("autoLength") && Point.Mode != TEXT("free")) return Fail(Error, TEXT("Unknown curve mode."));
        Point.HasInSlope = P->HasField(TEXT("inSlope")); Point.HasOutSlope = P->HasField(TEXT("outSlope"));
        if ((Point.HasInSlope && !Number(P, TEXT("inSlope"), Point.InSlope)) ||
            (Point.HasOutSlope && !Number(P, TEXT("outSlope"), Point.OutSlope)) ||
            (P->HasField(TEXT("inLen")) && !Number(P, TEXT("inLen"), Point.InLen)) ||
            (P->HasField(TEXT("outLen")) && !Number(P, TEXT("outLen"), Point.OutLen)) ||
            Point.InLen < 0 || Point.InLen > 3 || Point.OutLen < 0 || Point.OutLen > 3) return Fail(Error, TEXT("Invalid curve handle."));
        Points.Add(Point); Previous = Point.X;
    }
    if (Points[0].X != 0 || Points.Last().X != 1) return Fail(Error, TEXT("Curve endpoint x must be 0 and 1."));
    if (Config) { Points[0].Y = Start; Points.Last().Y = End; }
    return true;
}
bool Decode(const FString& Raw, const FColumn& Column, FDevcelValue& Out, TArray<FCurvePoint>& Curve, FString& Error)
{
    Out.Type = Column.Type; Out.Raw = Raw;
    const FString& T = Column.Type;
    if ((T.StartsWith(TEXT("I")) || T.StartsWith(TEXT("U"))) && (T.Mid(1) == TEXT("8") || T.Mid(1) == TEXT("16") || T.Mid(1) == TEXT("32") || T.Mid(1) == TEXT("64")))
        return Integer(Raw, T[0] == 'I', FCString::Atoi(*T.Mid(1)), Out) || Fail(Error, TEXT("Integer outside declared range."));
    if (T == TEXT("F32") || T == TEXT("F64"))
    {
        FString Text = Raw.TrimStartAndEnd(); if (Text.IsEmpty()) Text = TEXT("0");
        FRegexMatcher Match(FRegexPattern(TEXT("^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")), Text);
        if (!Match.FindNext()) return Fail(Error, TEXT("Invalid floating-point value."));
        Out.Number = FCString::Atod(*Text);
        if (!std::isfinite(Out.Number) || (T == TEXT("F32") && !std::isfinite(float(Out.Number)))) return Fail(Error, TEXT("Floating-point value outside finite range."));
        if (T == TEXT("F32")) Out.Number = float(Out.Number);
        return true;
    }
    if (T == TEXT("Boolean"))
    {
        FString Text = Raw.TrimStartAndEnd().ToLower(); if (Text.IsEmpty()) Text = TEXT("false");
        if (Text != TEXT("true") && Text != TEXT("false")) return Fail(Error, TEXT("Boolean must be true/false."));
        Out.Boolean = Text == TEXT("true"); return true;
    }
    if (T == TEXT("Color32") || T == TEXT("ColorFloat")) return DecodeColor(Raw, T == TEXT("Color32"), Out, Error);
    if (T == TEXT("Curve")) return DecodeCurve(Raw, Column.CurveConfig, Curve, Error);
    return true;
}
double Bezier(double A, double B, double C, double D, double T)
{ double U = 1 - T; return U*U*U*A + 3*U*U*T*B + 3*U*T*T*C + T*T*T*D; }
double AutoSlope(const TArray<FCurvePoint>& P, int32 I)
{
    const auto& A = P[FMath::Max(0, I - 1)]; const auto& B = P[FMath::Min(P.Num() - 1, I + 1)];
    return (B.Y - A.Y) / FMath::Max(1.e-9, B.X - A.X);
}
TPair<double, double> Handle(const TArray<FCurvePoint>& P, int32 I, bool Out)
{
    const auto& V = P[I];
    if (V.Mode == TEXT("constant")) return {0, 1};
    if (V.Mode == TEXT("linear")) { const auto& B = P[I + (Out ? 1 : -1)]; return {(B.Y - V.Y)/(B.X - V.X), 1}; }
    double Slope = AutoSlope(P, I);
    if (V.Mode == TEXT("free") && (Out ? V.HasOutSlope : V.HasInSlope)) Slope = Out ? V.OutSlope : V.InSlope;
    return {Slope, Out ? V.OutLen : V.InLen};
}
}
struct FDevcelSnapshot
{
    TMap<FString, FTable> Tables;
    TMap<FString, FString> ByUuid;
    TArray<FString> Order;
};

namespace
{
bool Parse(const FString& Text, TSharedPtr<FDevcelSnapshot>& Result, FString& Error)
{
    Error.Reset(); TSharedPtr<FJsonObject> Root;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root) return Fail(Error, TEXT("Invalid JSON object."));
    const TSharedPtr<FJsonObject>* Manifest;
    const TArray<TSharedPtr<FJsonValue>>* Tables;
    FString Hash, Mode, Generated, Project; double Schema, Revision;
    if (!Root->TryGetObjectField(TEXT("manifest"), Manifest) || !Root->TryGetArrayField(TEXT("tables"), Tables) ||
        !Root->TryGetStringField(TEXT("project_name"), Project) || !Number(*Manifest, TEXT("schema_version"), Schema) || Schema != 1 ||
        !Name(*Manifest, TEXT("content_hash"), Hash) || !Name(*Manifest, TEXT("mode"), Mode) || (Mode != TEXT("full") && Mode != TEXT("minimal")) ||
        !Name(*Manifest, TEXT("generated_at"), Generated) || !Number(*Manifest, TEXT("data_revision"), Revision) || !Whole(Revision) || Revision < 0)
        return Fail(Error, TEXT("Expected canonical schema_version 1 manifest/tables."));
    auto Version = (*Manifest)->TryGetField(TEXT("content_version"));
    double V;
    if (Version && Version->Type != EJson::Null && (!Version->TryGetNumber(V) || !Whole(V) || V < 0 || V > MAX_uint32))
        return Fail(Error, TEXT("Invalid content_version."));
    auto Candidate = MakeShared<FDevcelSnapshot>();
    for (const auto& Item : *Tables)
    {
        if (!Item || Item->Type != EJson::Object) return Fail(Error, TEXT("Invalid table."));
        auto Object = Item->AsObject(); FTable Table;
        const TArray<TSharedPtr<FJsonValue>> *Columns, *Rows;
        if (!Name(Object, TEXT("name"), Table.Name) || !Name(Object, TEXT("uuid"), Table.Uuid) ||
            Candidate->Tables.Contains(Table.Name) || Candidate->ByUuid.Contains(Table.Uuid) ||
            !Object->TryGetArrayField(TEXT("columns"), Columns) || !Object->TryGetArrayField(TEXT("records"), Rows))
            return Fail(Error, TEXT("Invalid or duplicate table identity/arrays."));
        if (Object->HasField(TEXT("interfaces")) && !Object->TryGetStringArrayField(TEXT("interfaces"), Table.Interfaces))
            return Fail(Error, TEXT("interfaces must be strings."));
        for (const auto& ColumnItem : *Columns)
        {
            if (!ColumnItem || ColumnItem->Type != EJson::Object) return Fail(Error, TEXT("Invalid column."));
            auto O = ColumnItem->AsObject(); FString ColumnName; FColumn Column;
            if (!Name(O, TEXT("name"), ColumnName) || Table.Columns.Contains(ColumnName) || !Name(O, TEXT("data_type"), Column.Type))
                return Fail(Error, TEXT("Invalid or duplicate column."));
            static const TSet<FString> Types = {TEXT("None"),TEXT("String"),TEXT("Select"),TEXT("DateTime"),TEXT("Reference"),TEXT("TableRef"),TEXT("Curve"),
                TEXT("U8"),TEXT("I8"),TEXT("U16"),TEXT("I16"),TEXT("U32"),TEXT("I32"),TEXT("U64"),TEXT("I64"),TEXT("F32"),TEXT("F64"),TEXT("Boolean"),TEXT("Color32"),TEXT("ColorFloat")};
            if (!Types.Contains(Column.Type)) return Fail(Error, TEXT("Unknown column type: ") + Column.Type);
            Column.Default = Column.Type == TEXT("Color32") ? TEXT("[255,255,255,255]") : Column.Type == TEXT("ColorFloat") ? TEXT("[1,1,1,1]") : TEXT("");
            auto Default = O->TryGetField(TEXT("default_value"));
            if (Default && Default->Type != EJson::Null && !Default->TryGetString(Column.Default)) return Fail(Error, TEXT("default_value must be text."));
            for (const TCHAR* Key : {TEXT("reference_config"), TEXT("table_ref_config"), TEXT("curve_config")})
            {
                auto Value = O->TryGetField(Key);
                if (!Value || Value->Type == EJson::Null) continue;
                if (Value->Type != EJson::Object) return Fail(Error, TEXT("Invalid column configuration."));
                auto Config = Value->AsObject();
                if (FCString::Strcmp(Key, TEXT("curve_config")) == 0) Column.CurveConfig = Config;
                else
                {
                    const TCHAR* Field = FCString::Strcmp(Key, TEXT("reference_config")) == 0 ? TEXT("target_table_uuid") : TEXT("interface_uuid");
                    FString Target;
                    if (Config->HasField(Field) && !Config->TryGetStringField(Field, Target)) return Fail(Error, TEXT("Reference configuration must contain text."));
                    if (FCString::Strcmp(Field, TEXT("target_table_uuid")) == 0) Column.TargetUuid = Target; else Column.InterfaceUuid = Target;
                }
            }
            if (!Decode(Column.Default, Column, Column.DefaultValue, Column.DefaultCurve, Error)) return false;
            Table.Columns.Add(ColumnName, MoveTemp(Column));
        }
        for (const auto& RowItem : *Rows)
        {
            if (!RowItem || RowItem->Type != EJson::Object) return Fail(Error, TEXT("Invalid row."));
            auto O = RowItem->AsObject(); FString Id; const TSharedPtr<FJsonObject>* Values;
            if (!Name(O, TEXT("id"), Id) || Table.Rows.Contains(Id) || !O->TryGetObjectField(TEXT("values"), Values))
                return Fail(Error, TEXT("Invalid or duplicate row."));
            for (const auto& Pair : (*Values)->Values)
                if (!Pair.Value || Pair.Value->Type != EJson::String || !Table.Columns.Contains(Pair.Key)) return Fail(Error, TEXT("Invalid/unknown cell; canonical values must be text."));
            FRow Row;
            for (const auto& Pair : Table.Columns)
            {
                FString Raw = Pair.Value.Default; (*Values)->TryGetStringField(Pair.Key, Raw);
                FDevcelValue Value; TArray<FCurvePoint> Curve;
                if (Raw == Pair.Value.Default)
                {
                    Value = Pair.Value.DefaultValue; Curve = Pair.Value.DefaultCurve;
                }
                else if (!Decode(Raw, Pair.Value, Value, Curve, Error)) { Error = Table.Name + TEXT("/") + Id + TEXT("/") + Pair.Key + TEXT(": ") + Error; return false; }
                Row.Values.Add(Pair.Key, MoveTemp(Value));
                if (!Curve.IsEmpty()) Row.Curves.Add(Pair.Key, MoveTemp(Curve));
            }
            Table.Order.Add(Id); Table.Rows.Add(Id, MoveTemp(Row));
        }
        Candidate->Order.Add(Table.Name); Candidate->ByUuid.Add(Table.Uuid, Table.Name); Candidate->Tables.Add(Table.Name, MoveTemp(Table));
    }
    Result = MoveTemp(Candidate); return true;
}
}

bool UDevcelDataAsset::Load(FString& Error)
{
    check(IsInGameThread()); Error.Reset();
    return Snapshot.IsValid() || Parse(CanonicalJson, Snapshot, Error);
}
bool UDevcelDataAsset::ReplaceJson(const FString& Json, FString& Error, bool bNotify)
{
    check(IsInGameThread()); Error.Reset();
    // CanonicalJson is privately owned and was validated with this snapshot.
    // A matching manifest hash alone is never sufficient to skip validation.
    if (Snapshot.IsValid() && Json == CanonicalJson) return true;
    TSharedPtr<FDevcelSnapshot> Candidate;
    if (!Parse(Json, Candidate, Error)) return false;
    CanonicalJson = Json; Snapshot = MoveTemp(Candidate); ++Revision;
    if (bNotify) NotifyReloaded();
    return true;
}
#if WITH_EDITOR
void UDevcelDataAsset::RestoreAfterFailedSave(const FString& PreviousJson, int64 PreviousRevision)
{
    check(IsInGameThread());
    CanonicalJson = PreviousJson;
    Snapshot.Reset(); // The next lookup reconstructs the previously published snapshot.
    Revision = PreviousRevision;
}
#endif
void UDevcelDataAsset::NotifyReloaded() { check(IsInGameThread()); OnReloaded.Broadcast(Revision); }
TArray<FString> UDevcelDataAsset::GetTables() { FString Error; return Load(Error) ? Snapshot->Order : TArray<FString>(); }
TArray<FString> UDevcelDataAsset::GetRecordIds(const FString& Table)
{
    FString Error; if (!Load(Error)) return {}; const auto* Found = Snapshot->Tables.Find(Table); return Found ? Found->Order : TArray<FString>();
}
bool UDevcelDataAsset::GetValue(const FString& Table, const FString& RecordId, const FString& Column, FDevcelValue& Value, FString& Error)
{
    Value = FDevcelValue(); if (!Load(Error)) return false;
    const auto* T = Snapshot->Tables.Find(Table); const auto* R = T ? T->Rows.Find(RecordId) : nullptr;
    const auto* V = R ? R->Values.Find(Column) : nullptr;
    if (!V) return Fail(Error, TEXT("Missing table, record or column (possibly filtered by ContentVersion)."));
    Value = *V; return true;
}
bool UDevcelDataAsset::GetUnsignedInteger(const FString& Table, const FString& RecordId, const FString& Column, uint64& Value, FString& Error)
{
    Value = 0; FDevcelValue V;
    if (!GetValue(Table, RecordId, Column, V, Error)) return false;
    if (V.UnsignedDecimal.IsEmpty()) return Fail(Error, TEXT("The column is not an unsigned integer."));
    Value = V.UnsignedInteger; return true;
}
bool UDevcelDataAsset::ResolveReference(const FString& Table, const FString& RecordId, const FString& Column, FString& TargetTable, FString& TargetRecord, FString& Error)
{
    TargetTable.Reset(); TargetRecord.Reset(); FDevcelValue V;
    if (!GetValue(Table, RecordId, Column, V, Error)) return false;
    if (V.Type != TEXT("Reference")) return Fail(Error, TEXT("Expected Reference column."));
    if (V.Raw.IsEmpty()) return Fail(Error, TEXT("Reference is empty."));
    const FString* Name = Snapshot->ByUuid.Find(Snapshot->Tables[Table].Columns[Column].TargetUuid);
    if (!Name || !Snapshot->Tables[*Name].Rows.Contains(V.Raw)) return Fail(Error, TEXT("Reference target is absent or filtered out."));
    TargetTable = *Name; TargetRecord = V.Raw; return true;
}
bool UDevcelDataAsset::ResolveTableReference(const FString& Table, const FString& RecordId, const FString& Column, FString& TargetTable, FString& Error)
{
    TargetTable.Reset(); FDevcelValue V;
    if (!GetValue(Table, RecordId, Column, V, Error)) return false;
    if (V.Type != TEXT("TableRef")) return Fail(Error, TEXT("Expected TableRef column."));
    const FString* Name = Snapshot->ByUuid.Find(V.Raw);
    if (!Name) return Fail(Error, TEXT("TableRef target is absent."));
    const FString& Interface = Snapshot->Tables[Table].Columns[Column].InterfaceUuid;
    if (!Interface.IsEmpty() && !Snapshot->Tables[*Name].Interfaces.Contains(Interface)) return Fail(Error, TEXT("TableRef target does not implement its required interface."));
    TargetTable = *Name; return true;
}
bool UDevcelDataAsset::SampleCurve(const FString& Table, const FString& RecordId, const FString& Column, double X, double& Y, FString& Error)
{
    Y = 0; FDevcelValue V;
    if (!GetValue(Table, RecordId, Column, V, Error)) return false;
    if (V.Type != TEXT("Curve") || !std::isfinite(X)) return Fail(Error, TEXT("Expected Curve and finite sample position."));
    const auto& P = Snapshot->Tables[Table].Rows[RecordId].Curves[Column];
    if (X <= P[0].X) { Y = P[0].Y; return true; }
    if (X >= P.Last().X) { Y = P.Last().Y; return true; }
    int32 I = 0; while (I < P.Num() - 2 && P[I + 1].X <= X) ++I;
    const auto& A = P[I]; const auto& B = P[I + 1];
    if (A.Mode == TEXT("constant") || X == A.X) { Y = A.Y; return true; }
    const auto H1 = Handle(P, I, true); const auto H2 = Handle(P, I + 1, false);
    double L1 = (B.X - A.X) / 3 * H1.Value, L2 = (B.X - A.X) / 3 * H2.Value, Low = 0, High = 1;
    for (int32 J = 0; J < 40; ++J)
    { double Mid = (Low + High) * .5; if (Bezier(A.X, A.X + L1, B.X - L2, B.X, Mid) < X) Low = Mid; else High = Mid; }
    Y = Bezier(A.Y, A.Y + H1.Key * L1, B.Y - H2.Key * L2, B.Y, (Low + High) * .5); return true;
}
