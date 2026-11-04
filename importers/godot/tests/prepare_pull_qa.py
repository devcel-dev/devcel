#!/usr/bin/env python3
"""Create a standalone two-source Editor/Play QA title. New empty directory only."""
import json,pathlib,shutil,subprocess,sys
from prepare_bundled_cli import install_bundled_cli
cli=pathlib.Path(sys.argv[1]).resolve();root=pathlib.Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True)
if any(root.iterdir()): raise SystemExit('Use a new empty fixture directory')
def run(*args):
 r=subprocess.run([str(cli),*map(str,args)],capture_output=True,text=True,check=True);return json.loads(r.stdout)['data']
source=pathlib.Path(run('init','Base','--dir',root/'authoring')['project_path'])
def edit(p,*args):return run('--mode','local','--project',p,*args)
edit(source,'table','create','Items');edit(source,'column','add','Items','hp','I32')
row='11111111-1111-4111-8111-111111111111'
edit(source,'record','add','Items','--uuid',row);edit(source,'cell','set','Items',row,'hp','7')
shutil.copytree(source.parent,root/'authoring/Event');event=root/'authoring/Event'/source.name
edit(event,'cell','set','Items',row,'hp','99')
engine=root/'title';engine.mkdir();shutil.copytree(pathlib.Path(__file__).resolve().parents[1]/'addons',engine/'addons')
(engine/'.devcel').mkdir();config={'schema_version':1,'sources':[
 {'id':'base','project':str(source),'namespace':'Game.Base','runtime_out':str(engine/'data/base.json'),'mode':'full'},
 {'id':'event','project':str(event),'namespace':'Game.Event','runtime_out':str(engine/'data/event.json'),'mode':'minimal'}]}
configpath=engine/'.devcel/devcel.import.json';configpath.write_text(json.dumps(config,indent=2))
install_bundled_cli(cli, engine)
(engine/'.devcel/pull-editor.cfg').write_text('[pull]\nsync_modes={}\n')
(engine/'project.godot').write_text('''config_version=5
[application]
config/name="Devcel Pull QA"
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=960
window/size/viewport_height=600
[editor_plugins]
enabled=PackedStringArray("res://addons/devcel/plugin.cfg")
[rendering]
renderer/rendering_method="gl_compatibility"
''')
(engine/'main.tscn').write_text('''[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://main.gd" id="1"]
[node name="PullQA" type="Node"]
script = ExtResource("1")
''')
(engine/'main.gd').write_text('''extends Node
const Live = preload("res://addons/devcel/runtime/devcel_live_database.gd")
var views: Dictionary = {}
func _ready():
    var panel := VBoxContainer.new()
    panel.position = Vector2(50, 50)
    add_child(panel)
    var title := Label.new()
    title.text = "Importer Pull · same UUID, independent projects"
    title.add_theme_font_size_override("font_size", 28)
    panel.add_child(title)
    for id in ["base", "event"]:
        var label := Label.new()
        label.add_theme_font_size_override("font_size", 40)
        panel.add_child(label)
        var live = Live.new()
        live.bundle_path = "res://data/" + id + ".json"
        views[id] = {"live": live, "label": label}
        live.reloaded.connect(func(): update_source(id))
        live.reload_failed.connect(func(message): label.text = id + ": " + message)
        add_child(live)
    var help := Label.new()
    help.text = "Save a source change, then Pull that source in the Editor.\nThe other project's value stays unchanged."
    panel.add_child(help)
func update_source(id: String):
    var entry: Dictionary = views[id]
    entry.label.text = id + " hp = " + str(entry.live.database.by_id("Items", "11111111-1111-4111-8111-111111111111").get_int("hp"))
    print("PULL_QA ", entry.label.text)
''')
run('pull','--config',configpath)
(root/'QA.json').write_text(json.dumps({'title':str(engine),'config':str(configpath),'cli':str(cli),'source_base':str(source),'source_event':str(event),'row':row},indent=2))
print(json.dumps({'ok':True,'title':str(engine),'instructions':'Open project.godot, check both ready, F5 gives base=7/event=99. Set event hp=555, pull event; Play updates only event.'}))
