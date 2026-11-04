using UnrealBuildTool;
public class DevcelEditor : ModuleRules
{
    public DevcelEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[] {
            "Core", "CoreUObject", "Engine", "DevcelRuntime", "Json", "UnrealEd",
            "Slate", "SlateCore", "ToolMenus", "DesktopPlatform", "Projects", "AssetRegistry"
        });
    }
}
