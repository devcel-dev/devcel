#include "devcel_runtime.h"
#include "Devcel.h"
#include "DevcelOther.h"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <type_traits>
using devcel::Database;
const char* hero="22222222-2222-4222-8222-222222222222";
const char* item="11111111-1111-4111-8111-111111111111";
template<class F> void throws(F f){bool hit=false;try{f();}catch(const std::exception&){hit=true;}assert(hit);}
int main(int argc,char**argv){
 assert(argc==2);std::filesystem::path dir(argv[1]);auto live=dir/"cpp-live.json";
 for(const auto& entry:std::filesystem::directory_iterator(dir)){
  if(entry.path().filename().string().rfind("invalid-current-",0)==0) assert(!Database::open(entry.path().c_str()));
 }
 std::filesystem::copy_file(dir/"bundle-initial.json",live,std::filesystem::copy_options::overwrite_existing);
 assert(!Database::open("/devcel-does-not-exist"));auto db=Database::open(live.c_str());assert(db);
 static_assert(!std::is_copy_constructible<Database>::value);
 static_assert(std::is_same<devcel::DevcelColor32, DevcelOther::DevcelColor32>::value);
 auto second=DevcelOther::Database::open(live.c_str());assert(second && second->heroes.by_id(hero)->light().g==4.f);
 assert(db->heroes.count()==1);auto old=db->heroes.by_id(hero).value();
 static_assert(std::is_same<decltype(old.tint()), devcel::DevcelColor32>::value);
 static_assert(std::is_same<decltype(old.light()), devcel::DevcelColorFloat>::value);
 assert(old.tint().r==18 && old.tint().g==171 && old.tint().b==239 && old.tint().a==0);
 assert(old.light().r==-0.25f && old.light().g==4.f && old.light().b==0.5f && old.light().a==0.f);
 assert(old.hp()==42);assert(old.name()=="勇者\nHero");assert(old.weapon()->power()==20);
 assert(old.limit()==UINT64_MAX);assert(old.floor()==INT64_MIN);assert(old.enabled());assert(old.speed()==1.5);assert(old.computed()==84);assert(old.class_()=="keyword");
 auto min=Database::open((dir/"minimal-initial.json").c_str());assert(min->heroes.by_id(hero)->hp()==42);assert(min->heroes.by_id(hero)->limit()==UINT64_MAX);assert(min->items.by_id(item)->power()==20);assert(min->heroes.by_id(hero)->tint().r==18);assert(min->heroes.by_id(hero)->light().g==4.f);
 Database moved=std::move(*db);assert(old.hp()==42);assert(moved.heroes.by_id(hero)->weapon()->power()==20);
 auto temporary=devcel::ItemsTable(moved).by_id(item).value();assert(temporary.power()==20);
 throws([&]{(void)moved.heroes[-1];});throws([&]{(void)moved.heroes[10];});
 assert(!moved.reload_if_changed());
 {std::ofstream f(live);f<<"invalid json";}throws([&]{moved.reload_if_changed();});assert(old.hp()==42);
 std::filesystem::copy_file(dir/"bundle-updated.json",live,std::filesystem::copy_options::overwrite_existing);
 assert(moved.reload_if_changed());throws([&]{(void)old.hp();});throws([&]{(void)old.tint();});throws([&]{(void)old.light();});assert(moved.heroes.count()==2);
 auto fresh=moved.heroes.by_id(hero).value();assert(fresh.hp()==777);assert(fresh.weapon()->power()==20);assert(fresh.name()=="勇者\nHero");
 assert(fresh.computed()==1554);moved.close();throws([&]{(void)fresh.hp();});throws([&]{(void)fresh.tint();});throws([&]{(void)moved.heroes.count();});
 auto orphan=[&](){auto scoped=Database::open((dir/"bundle-initial.json").c_str());return scoped->heroes.by_id(hero).value();}();throws([&]{(void)orphan.hp();});
 std::cout<<"C++ runtime/codegen: factory, references, boundaries, defaults, move, temporary, reload/reorder, stale rows, close PASS\n";
}
