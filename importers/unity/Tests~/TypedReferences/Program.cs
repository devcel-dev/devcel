using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Game.Master;
static class Program
{
    static long sink;
    static void Require(bool value,string message) { if(!value) throw new Exception(message); }
    static void Throws<T>(Action action) where T:Exception {try{action();}catch(T){return;}throw new Exception("Expected "+typeof(T).Name);}
    static JsonObject Enemy(JsonNode doc) => doc["tables"]!.AsArray().First(t=>t!["name"]!.GetValue<string>()=="enemies")!.AsObject();
    static void Publish(string path,JsonNode doc,GameDatabase db,string hash) {doc["manifest"]!["content_hash"]=hash;File.WriteAllText(path,doc.ToJsonString());Require(db.ReloadIfChanged(),"reload "+hash);}
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    static void AddRetiredView(GameDatabase db) { _=db.GetTableView("temporary-view",string.Empty); }
    static void Main(string[] args)
    {
        string directory=args[0]; string full=File.ReadAllText(Path.Combine(directory,"bundle.json"));
        foreach(var file in new[]{"bundle.json","minimal.json"}) {
            using var db=GameDatabase.FromJson(File.ReadAllText(Path.Combine(directory,file)));
            var a=db.Get(EnemiesReferences.Slime)!; var b=db.Get(PropsReferences.Barrel)!;
            Require(a.Uuid==b.Uuid,"same UUID fixture");
            Require(((IDamageableHandle)a).Hp==42 && ((IDamageableHandle)b).Hp==91,"table identities");
            Require(db.Get(EnemiesReferences.Slime.AsDamageable())!.Hp==42,"interface local");
            Require(db.Get(EnemiesReferences.Slime.AsArmored())!.Hp==100,"same-name interface UUID binding");
            Require(db.Get(EnemiesReferences.Child.AsDamageable())!.Hp==42,"parent value");
            Require(db.Get(new EnemiesReference("00000000-0000-4000-8000-000000000002").AsDamageable())!.Hp==7,"default value");
            Require(db.Get(new EnemiesReference())==null && db.Get(new EnemiesReference("missing"))==null,"empty/missing");
            Require(!db.TryGet(new IDamageableReference("missing",a.Uuid),out var missing)&&missing==null,"missing table");
            db.Dispose();Require(db.LiveEnemies.Count==0 && db.LiveProps.Count==0 && db.MembersEnemies.Length==0 && db.TableViews.Count==0,"disposed owner releases managed indexes");Throws<ObjectDisposedException>(()=>{_=a.Name;});Throws<ObjectDisposedException>(()=>{_=a.Exists;});
        }
        ValidatePublicationStrings(full);
        var document=JsonNode.Parse(full)!; string path=Path.Combine(directory,"live-test.json");File.WriteAllText(path,full);
        using(var db=GameDatabase.Open(path)) {
            ZeroAcquisition(db,"first after load");
            var a=db.Get(EnemiesReferences.Slime)!; var i=db.Get(EnemiesReferences.Slime.AsDamageable())!;
            var raw=db.Enemies.ById(a.Uuid)!.Value;
            var child=a.Friend!;Require(child.Hp==91 && ReferenceEquals(child,a.Friend),"nested handle cached");
            var collection=a.CatalogTable!.AsProps()!;var membershipSnapshot=collection.GetEnumerator();
            AddRetiredView(db); GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            Require(db.TableViews.ContainsKey(("temporary-view",string.Empty)),"dead view registry fixture");
            var requiredView=a.CatalogTable!;
            var unrestrictedView=db.GetTableView(requiredView.Uuid,string.Empty); unrestrictedView.Prepare();
            Require(!ReferenceEquals(requiredView,unrestrictedView),"different interface constraints never share a view");
            Require(ReferenceEquals(unrestrictedView,db.GetTableView(requiredView.Uuid,string.Empty)),"same identity and constraint share a view");
            Require(collection.Count==1 && collection[0].Uuid==child.Uuid,"live collection returns stable handles");
            var rows=Enemy(document)["records"]!.AsArray(); var first=rows[0]!; rows.RemoveAt(0); rows.Add(first);
            first["values"]!["name"]="Updated"; first["values"]!["Damageable_hp"]="123";
            var columns=Enemy(document)["columns"]!.AsArray(); var col=columns[0];columns.RemoveAt(0);columns.Add(col);
            document["tables"]!.AsArray().First(t=>t!["name"]!.GetValue<string>()=="props")!["records"]![0]!["values"]!["hp"]="191";
            Publish(path,document,db,"reordered");
            ZeroAcquisition(db,"first after reload"); Require(!db.TableViews.ContainsKey(("temporary-view",string.Empty)),"publication removes expired weak view registry entry");
            Require(child.Hp==191 && a.Friend!.Hp==191,"retained nested handle reads updated child");
            Require(membershipSnapshot.MoveNext() && membershipSnapshot.Current.Hp==191,"snapshot membership with live values");
            Require(ReferenceEquals(a.CatalogTable,a.CatalogTable),"table handle cached");
            Require(a.Name=="Updated" && i.Hp==123,"retained handles update after row+column reorder");
            Require(a.ResolutionCount==2 && a.ResolutionCount==2,"one resolution per generation");
            var array=new[]{a};var list=new List<EnemiesHandle>{a};
            for(int k=0;k<100;k++)Require(array[0].DamageableHp+list[0].DamageableHp+i.Hp==369,"array/list/interface cache");
            Require(a.ResolutionCount==2,"no hot UUID lookup");
            Throws<InvalidOperationException>(()=>{_=raw.Name;});
            File.WriteAllText(path,"invalid");Throws<InvalidOperationException>(()=>db.ReloadIfChanged());Require(a.Name=="Updated"&&a.ResolutionCount==2,"failed reload retains valid snapshot/cache");
            rows.Remove(first); var replacement=first.DeepClone();replacement["id"]="00000000-0000-4000-8000-000000000099";rows.Add(replacement);
            Publish(path,document,db,"deleted");Require(!a.Exists&&!i.Exists,"deleted handles missing");Throws<KeyNotFoundException>(()=>{_=a.Name;});
            int misses=a.ResolutionCount;for(int k=0;k<100;k++)Require(!a.Exists,"negative cache");Require(a.ResolutionCount==misses,"missing cached per generation");
            rows.Add(first);Publish(path,document,db,"reappeared");Require(a.Exists&&a.Name=="Updated"&&i.Hp==123 && ReferenceEquals(a,db.Get(EnemiesReferences.Slime)),"same UUID reappearance retains externally held identity");
            var membership=Enemy(document)["interfaces"]!.DeepClone();Enemy(document)["interfaces"]=new JsonArray();Publish(path,document,db,"detached");Require(a.Exists&&!i.Exists,"interface detach does not detach table");Throws<KeyNotFoundException>(()=>{_=((IDamageableHandle)a).Hp;});Throws<KeyNotFoundException>(()=>{_=i.Hp;});
            Enemy(document)["interfaces"]=membership;Publish(path,document,db,"reattached");Require(i.Hp==123,"interface reattach");
            var props=document["tables"]!.AsArray().First(t=>t!["name"]!.GetValue<string>()=="props")!;
            var savedMembership=props["interfaces"]!.DeepClone();props["interfaces"]=new JsonArray();
            Publish(path,document,db,"collection-detached");Require(!collection.Exists,"retained collection keeps interface constraint"); Require(unrestrictedView.Exists,"unrestricted shared view remains available when interface detaches");
            Throws<KeyNotFoundException>(()=>{_=collection.Count;});Throws<KeyNotFoundException>(()=>{_=collection[0];});Throws<KeyNotFoundException>(()=>{_=membershipSnapshot.Current;});Throws<KeyNotFoundException>(()=>collection.GetEnumerator());
            props["interfaces"]=savedMembership;Publish(path,document,db,"collection-reattached");Require(collection.Exists&&collection.Count==1,"collection reattaches");
            db.LiveEnemies[a.Uuid]=null!;
            Throws<NullReferenceException>(()=>Publish(path,document,db,"managed-publication-fault"));
            Throws<InvalidOperationException>(()=>{_=a.Name;});
            db.LiveEnemies[a.Uuid]=a;
            Require(db.ReloadIfChanged(),"same file retries failed managed publication");Require(a.Name=="Updated","same-file publication recovered");
            var currentRaw=db.Enemies.ById(a.Uuid)!.Value;
            Measure("raw Row scalar",()=>currentRaw.DamageableHp);
            Measure("live table scalar",()=>a.DamageableHp);
            Measure("live interface scalar",()=>i.Hp);
            int before=a.ResolutionCount;Measure("live array scalar",()=>array[0].DamageableHp);Require(a.ResolutionCount==before,"benchmark no repeated resolution");
            Measure("nested reference scalar",()=>a.Friend!.Hp);
            MeasureCold(db);
            var errors=new List<Exception>(); bool stop=false;
            var reader=Task.Run(()=>{while(!Volatile.Read(ref stop))try{string name=a.Name;Require(name=="Updated"||name.StartsWith("Concurrent"),"torn string");_=i.Hp;}catch(Exception e){lock(errors)errors.Add(e);break;}});
            for(int n=0;n<30;n++){first["values"]!["name"]="Concurrent"+n+new string('x',2048);Publish(path,document,db,"concurrent"+n);}
            Volatile.Write(ref stop,true);reader.Wait();Require(errors.Count==0,"concurrent string/reload protected");
            var disposeReader=Task.Run(()=>{for(;;)try{_=a.Name;}catch(ObjectDisposedException){break;}});db.Dispose();Require(disposeReader.Wait(5000),"concurrent dispose terminates safely");
        }
        document=JsonNode.Parse(full)!;Enemy(document)["uuid"]="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        using(var db=GameDatabase.FromJson(document.ToJsonString()))Require(db.Get(EnemiesReferences.Slime)==null,"same-name wrong table UUID rejected");
        MeasureLoad(full);
        Console.WriteLine("LIVE_HANDLES_PASS full/minimal, identity, projection, inheritance/default, cache, reorder/delete/readd, detach/reattach, failed reload, concurrent string/reload/dispose");
    }
    static void ValidatePublicationStrings(string full) {
        foreach (string timestamp in new[]{"2026-10-26T12:34:56+09:00", "invalid", ""}) {
            var data=JsonNode.Parse(full)!;
            var values=Enemy(data)["records"]![0]!["values"]!;
            values["name"]="雪\0é😀"; values["when"]=timestamp;
            values["friend"]="missing";
            using var db=GameDatabase.FromJson(data.ToJsonString());
            var handle=db.Get(EnemiesReferences.Slime)!;
            var raw=db.Enemies.ById(handle.Uuid)!.Value;
            Require(handle.Name=="雪\0é😀" && raw.Name==handle.Name,"length-aware UTF8 preserves NUL and Unicode");
            Require(handle.When==timestamp && handle.WhenRfc3339==raw.WhenRfc3339,"eager DateTime uses the same parser and value");
            Require(handle.Friend==null && raw.Friend==null,"unresolved reference stays null");
        }
    }
    static void MeasureLoad(string full) {
        var large=JsonNode.Parse(full)!;var rows=Enemy(large)["records"]!.AsArray();var prototype=rows[0]!.DeepClone();rows.Clear();
        const int count=10000;
        for(int n=0;n<count;n++){var row=prototype.DeepClone();row["id"]=$"00000000-0000-4000-8000-{n+1:D12}";rows.Add(row);}
        string json=large.ToJsonString();var timer=new Stopwatch();
        GC.Collect();GC.WaitForPendingFinalizers();GC.Collect();long baseline=GC.GetTotalMemory(true);
        long before=GC.GetAllocatedBytesForCurrentThread();timer.Start();
        using var db=GameDatabase.FromJson(json);timer.Stop();long allocated=GC.GetAllocatedBytesForCurrentThread()-before;
        long retained=GC.GetTotalMemory(true)-baseline;
        Require(ReferenceEquals(db.MembersEnemies[0].CatalogTable,db.MembersEnemies[count-1].CatalogTable),"all rows share identical table-reference view");
        Require(db.TableViews.Count==1,"one weak table view entry for identical bindings");
        Console.WriteLine($"LOAD records={count+1} source_chars={json.Length} elapsed_ms={timer.Elapsed.TotalMilliseconds:F2} managed_alloc_bytes={allocated} managed_retained_delta={retained}; native memory excluded");
        ZeroAcquisition(db,"large first Get");
    }
    static void ZeroAcquisition(GameDatabase db,string phase) {
        var serialized = new EnemiesReference(EnemiesReferences.Slime.Uuid);
        var serializedInterface = new IDamageableReference(EnemiesReferences.Slime.AsDamageable().TableUuid, serialized.Uuid);
        long before=GC.GetAllocatedBytesForCurrentThread();
        var a=db.Get(serialized)!; var same=db.Get(EnemiesReferences.Slime)!;
        var i=db.Get(serializedInterface)!; var direct=(IDamageableHandle)a;
        long baseProperties=GC.GetAllocatedBytesForCurrentThread();
        bool typed = a.ByteValue==255 && a.SbyteValue==-128 && a.ShortValue==-1234 && a.UshortValue==60000
            && a.UintValue==4000000000U && a.LongValue==-9007199254740993L && a.UlongValue==9007199254740993UL
            && a.FloatValue==1.25f && a.DoubleValue==-2.5 && a.Enabled && a.Tint.R==128 && a.Hdr.R==-2
            && a.Choice=="Ready";
        long scalarBytes=GC.GetAllocatedBytesForCurrentThread();
        typed &= a.WhenRfc3339.HasValue && a.WhenRfc3339.Value.Year==2026;
        long dateBytes=GC.GetAllocatedBytesForCurrentThread();
        typed &= a.SampleGrowth(0.5)==20;
        long curveBytes=GC.GetAllocatedBytesForCurrentThread();
        sink+=a.Name.Length+i.Hp+direct.Hp+a.Friend!.Hp;
        var collection=a.CatalogTable!.AsProps()!;
        sink+=collection.Count+collection[0].Hp+collection.ById(collection[0].Uuid)!.Hp;
        foreach(var row in collection) sink+=row.Hp;
        sink+=db.Get(default(EnemiesKey))==null?1:0;
        long allocated=GC.GetAllocatedBytesForCurrentThread()-before;
        Require(ReferenceEquals(a,same),"Get reuses prepared handle");
        if(allocated!=0) Console.WriteLine($"ALLOC_DIAG base={baseProperties-before} scalar={scalarBytes-baseProperties} date={dateBytes-scalarBytes} curve={curveBytes-dateBytes} rest={allocated-(curveBytes-before)}");
        Require(typed,"all scalar/color/date/select/curve values");
        Require(allocated==0,$"{phase}: allocated {allocated} bytes");
        Console.WriteLine($"GC_ZERO {phase}: {allocated} bytes, Get/reference/key/string/interface/direct cast/nested/table/indexer/foreach/missing");
    }
    static void Measure(string label,Func<int> read) {
        for(int n=0;n<10000;n++)sink+=read();
        const int count=1000000;var results=new double[7]; long totalBytes=0;
        for(int sample=0;sample<results.Length;sample++) {
            var timer=new Stopwatch();long bytes=GC.GetAllocatedBytesForCurrentThread();timer.Start();long sum=0;for(int n=0;n<count;n++)sum+=read();timer.Stop();bytes=GC.GetAllocatedBytesForCurrentThread()-bytes;sink+=sum;
            results[sample]=timer.Elapsed.TotalMilliseconds*1000000/count;totalBytes+=bytes;
        }
        Array.Sort(results);
        Console.WriteLine($"BENCH {label}: median={results[3]:F1} min={results[0]:F1} max={results[6]:F1} ns/read, allocated={totalBytes} bytes/7000000 reads, warmup=10000 samples=7");
    }
    static void MeasureCold(GameDatabase db) {
        var reference=new EnemiesReference(EnemiesReferences.Slime.Uuid);
        Measure("Get cached serialized ref + scalar",()=>db.Get(reference)!.DamageableHp);
        Measure("Get named key + scalar",()=>db.Get(EnemiesReferences.Slime)!.DamageableHp);
        Measure("Get interface key + scalar",()=>db.Get(EnemiesReferences.Slime.AsDamageable())!.Hp);
        Measure("managed string length",()=>db.Get(reference)!.Name.Length);
    }
}
