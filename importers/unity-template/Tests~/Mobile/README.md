# Mobile validation

Run the archive/provenance checks from the repository root:

```sh
python scripts/test_unity_mobile.py
python scripts/test_unity_upm.py
```

On Windows with Unity 6 installed, run the actual C# binary validator against synthetic ELF/Mach-O archive fixtures:

```powershell
python importers/unity-template/Tests~/Mobile/run.py --unity-data "C:/Program Files/Unity/Hub/Editor/6000.3.27f1/Editor/Data" --work-dir "C:/path/outside/repository/mobile-checks"
```

This compiles `DevcelNativeBinary.cs` with Unity's bundled compiler and executes Android, iOS device/Simulator and WebGL acceptance/rejection cases using Mono. Only the BuildTarget enum is mocked. No Unity Editor, native runtime or Player executes. The Python tests check exact version/source/hash matching, required NDK notices, Android 16 KB-compatible ELF segments and iOS device/Simulator archive headers and WebAssembly objects.

The `Unity mobile runtime builds` workflow compiles actual Android, iOS device/Simulator and WebGL libraries. Compilation does not establish Unity import, IL2CPP linkage or device runtime correctness. Follow [mobile acceptance](../../Documentation~/MOBILE.md) on actual devices before shipping.
