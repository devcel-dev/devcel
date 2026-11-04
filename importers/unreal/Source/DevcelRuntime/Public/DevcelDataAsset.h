#pragma once
#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "DevcelDataAsset.generated.h"

/** A value keeps its wire text as well as its native representation. No integer is parsed via double. */
USTRUCT(BlueprintType)
struct DEVCELRUNTIME_API FDevcelValue
{
    GENERATED_BODY()
    UPROPERTY(BlueprintReadOnly, Category="Devcel") FString Type;
    UPROPERTY(BlueprintReadOnly, Category="Devcel") FString Raw;
    UPROPERTY(BlueprintReadOnly, Category="Devcel") int64 SignedInteger = 0;
    /** Blueprint has no uint64 pin. Use this exact decimal string, or GetUnsignedInteger in C++. */
    UPROPERTY(BlueprintReadOnly, Category="Devcel") FString UnsignedDecimal;
    UPROPERTY(BlueprintReadOnly, Category="Devcel") double Number = 0;
    UPROPERTY(BlueprintReadOnly, Category="Devcel") bool Boolean = false;
    UPROPERTY(BlueprintReadOnly, Category="Devcel") FColor Color32 = FColor::White;
    /** Straight-alpha channels. Negative and >1 RGB are preserved; no gamma conversion. */
    UPROPERTY(BlueprintReadOnly, Category="Devcel") FLinearColor ColorFloat = FLinearColor::White;
    uint64 UnsignedInteger = 0;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FDevcelReloaded, int64, Revision);
struct FDevcelSnapshot;

/** One complete source per asset, including when another source has identical table/record UUIDs. */
UCLASS(BlueprintType)
class DEVCELRUNTIME_API UDevcelDataAsset : public UDataAsset
{
    GENERATED_BODY()
public:
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Devcel") FString SourceId;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Devcel") FString CodeNamespace;
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="Devcel") FString ClassName;
    UPROPERTY(BlueprintAssignable, Category="Devcel") FDevcelReloaded OnReloaded;

    UFUNCTION(BlueprintCallable, Category="Devcel") bool Load(FString& Error);
    UFUNCTION(BlueprintPure, Category="Devcel") TArray<FString> GetTables();
    UFUNCTION(BlueprintPure, Category="Devcel") TArray<FString> GetRecordIds(const FString& Table);
    UFUNCTION(BlueprintCallable, Category="Devcel") bool GetValue(const FString& Table, const FString& RecordId,
        const FString& Column, FDevcelValue& Value, FString& Error);
    UFUNCTION(BlueprintCallable, Category="Devcel") bool ResolveReference(const FString& Table, const FString& RecordId,
        const FString& Column, FString& TargetTable, FString& TargetRecord, FString& Error);
    UFUNCTION(BlueprintCallable, Category="Devcel") bool ResolveTableReference(const FString& Table, const FString& RecordId,
        const FString& Column, FString& TargetTable, FString& Error);
    UFUNCTION(BlueprintCallable, Category="Devcel") bool SampleCurve(const FString& Table, const FString& RecordId,
        const FString& Column, double X, double& Y, FString& Error);
    UFUNCTION(BlueprintPure, Category="Devcel") int64 GetRevision() const { return Revision; }
    bool GetUnsignedInteger(const FString& Table, const FString& RecordId, const FString& Column, uint64& Value, FString& Error);

    /** Validate the entire next snapshot before replacing any live data. Game-thread only. */
    bool ReplaceJson(const FString& Json, FString& Error, bool bNotify = true);
    void NotifyReloaded();
#if WITH_EDITOR
    /** Roll back an unpublished editor save without advancing the externally visible revision. */
    void RestoreAfterFailedSave(const FString& PreviousJson, int64 PreviousRevision);
#endif
    const FString& GetCanonicalJson() const { return CanonicalJson; }
#if WITH_EDITORONLY_DATA
    /** Stable title-relative ownership marker. Never overwrite an unrelated asset. */
    UPROPERTY() FString ImportOwner;
#endif
private:
    UPROPERTY() FString CanonicalJson;
    UPROPERTY(Transient) int64 Revision = 0;
    TSharedPtr<FDevcelSnapshot> Snapshot;
};
