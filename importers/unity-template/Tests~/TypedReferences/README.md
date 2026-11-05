# Typed reference and live acquisition regression harness

The generator fixture is produced by `cargo test -p devcel-core --test unity_typed_references` with `DEVCEL_TYPED_REFS_OUT` pointing at a disposable output directory. Its `interfaces` child contains generated C# and Full/Minimal runtime bundles.

Build `TypedReferences.csproj` in Release with `GeneratedDirectory` pointing at that child. `TestFramework` defaults to `net8.0`; use an installed supported .NET target. Put the matching Release `devcel_runtime` library on the native loader path. Run the resulting assembly with the fixture directory argument.

The harness checks stable table and record identity, independently bound interface columns, inheritance/defaults, nested records, captured collection membership with live element values, row/column reorder, deletion/reappearance, interface removal/readdition, invalid reload, and concurrent reads/reload/disposal.

Acquisition allocation checks include the **first** calls after initial load and reload. They cover `Get` with serialized references and immutable keys, strings, interface dispatch and a direct interface cast, child records, table references, collection indexing, concrete `foreach`, and missing lookup. Timings use 10,000 warm-up calls and seven samples of 1,000,000 reads. Allocation counts are exact managed bytes, not rounded throughput. Load/reload preparation is outside the acquisition boundary.

`UnityEditorQA.cs` is copied into the disposable project's Editor folder together with the sample MonoBehaviour and ScriptableObject. Its `Run` entry point exercises Unity serialization, Undo/Redo, stale array selection, multi-object assignment, prefab overrides, interface picker filtering, stable `DevcelDatabaseAsset` ownership across TextAsset-to-file replacement, subsequent registered file reload and Mono acquisition allocation. A passing log ends with `TYPED_REFERENCE_UNITY_TESTS_PASS` and the Editor's successful exit. This is separate from visual Inspector QA and Player/IL2CPP verification.

## Public usage and allocation boundaries

```csharp
[SerializeField] EnemiesReference enemy;
[SerializeField] IDamageableReference damageable;

var row = database.Get(enemy);             // null if empty/missing
var named = database.Get(EnemiesReferences.Slime);
var target = database.Get(EnemiesReferences.Slime.AsDamageable());
if (row != null && row.Exists) Use(row.Name);
```

`EnemiesReferences.Slime` is an immutable value key. Call `.ToReference()` explicitly to create an Inspector reference object for authoring; there is no implicit allocating conversion. Passing it directly to `Get` uses the key overload and creates no object. References serialize identity only; runtime handles are not serialized. Retaining a handle does not retain a stale generation's values. Missing retained handles report `Exists == false`; value access throws rather than returning stale/default data. Disposed owners throw. Exception construction is not part of the allocation-free successful acquisition contract; use `Get`/`TryGet`/`Exists` for expected missing cases.

Concrete collection `foreach` uses a struct enumerator and captures membership from the published generation; its handles continue reading current values. Casting the collection to `IEnumerable<T>` uses the compatibility interface and boxes the enumerator. Use the concrete collection or indexer for nonallocating traversal. Copied primitive/string values are ordinary immutable snapshots; retain the handle to obtain later values. A retained child handle follows that child's UUID; reread the parent property to observe a retargeted relationship.

Generated reload/replacement/dispose methods coordinate with reads. Direct native mutation/close through the low-level `Handle` is unsupported and bypasses that ownership contract. Existing raw `Row` APIs remain generation-bound low-level views; reacquire those after reload.

Inspector labels are exact authored nonempty labels; otherwise the UUID is shown. Empty labels create no named key. Label spelling is not normalized or escaped; duplicate/invalid/reserved generated symbols fail generation with a diagnostic. Renaming a label changes the source symbol, not serialized UUID identity.

A failed native parse retains the last good bundle. A managed read-model publication failure blocks reads until a successful retry. If owner replacement fails after ownership transfer, both native resources are closed and the owner becomes disposed; create a new owner instead of using partially published values.
