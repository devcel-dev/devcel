using System;
using System.IO;
using Devcel.Generated;
class Smoke {
 static T Need<T>(T? value) where T:struct => value ?? throw new Exception("missing row");
 static void Check(bool value){if(!value)throw new Exception("assertion failed");}
 static void Throws(Action action){bool hit=false;try{action();}catch(Exception){hit=true;}Check(hit);}
 static void Main(string[]args){
  string dir=args[0],live=Path.Combine(dir,"csharp-live.json"),id="22222222-2222-4222-8222-222222222222";
  File.Copy(Path.Combine(dir,"bundle-initial.json"),live,true);
  Throws(()=>DevcelDatabase.Open("/devcel-does-not-exist"));
  foreach(var invalid in Directory.GetFiles(dir,"invalid-current-*.json")) Throws(()=>DevcelDatabase.Open(invalid));
  using var db=DevcelDatabase.Open(live);Check(db.Heroes.Count==1);var old=Need(db.Heroes.ById(id));
  Check(old.Hp==42 && old.Name=="勇者\nHero" && Need(old.Weapon).Power==20);
  Check(old.Limit==ulong.MaxValue && old.Floor==long.MinValue && old.Enabled && old.Speed==1.5 && old.Computed==84 && old.Class=="keyword");
  Check(old.Tint.R==18 && old.Tint.G==171 && old.Tint.B==239 && old.Tint.A==0);
  Check(old.Light.R==-0.25f && old.Light.G==4f && old.Light.B==0.5f && old.Light.A==0f);
  Check(System.Runtime.InteropServices.Marshal.SizeOf<DevcelColor32>()==4 && System.Runtime.InteropServices.Marshal.SizeOf<DevcelColorFloat>()==16);
  ICharacter colorContract=old;Check(colorContract.Tint.A==0 && colorContract.Light.G==4f);
  ICharacter contract=old; INamed named=old; Check(contract.Hp==42 && contract.Name==old.Name && named.Name==old.Name);
  using var minimal=DevcelDatabase.Open(Path.Combine(dir,"minimal-initial.json"));Check(Need(minimal.Heroes.ById(id)).Hp==42 && Need(minimal.Heroes.ById(id)).Limit==ulong.MaxValue);
  Throws(()=>{var row=db.Heroes[-1];});Throws(()=>{var row=db.Heroes[10];});Check(!db.ReloadIfChanged());
  Check(Need(minimal.Heroes.ById(id)).Tint.R==18 && Need(minimal.Heroes.ById(id)).Light.G==4f);
  File.WriteAllText(live,"invalid json");Throws(()=>db.ReloadIfChanged());Check(old.Hp==42);
  File.Copy(Path.Combine(dir,"bundle-updated.json"),live,true);Check(db.ReloadIfChanged());Throws(()=>{var value=old.Hp;});Throws(()=>{var value=old.Tint;});Throws(()=>{var value=old.Light;});Check(db.Heroes.Count==2);
  var fresh=Need(db.Heroes.ById(id));Check(fresh.Hp==777 && Need(fresh.Weapon).Power==20 && fresh.Computed==1554);
  db.Dispose();Throws(()=>{var value=fresh.Hp;});Throws(()=>{var value=fresh.Tint;});Throws(()=>{var n=db.Heroes.Count;});
  Console.WriteLine("C# runtime/codegen: references, inherited interface, boundaries, defaults, reload/reorder, stale rows, dispose PASS");
 }
}
