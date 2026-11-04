#!/usr/bin/env python3
"""DOM-only importer UI checks; native NW.js behavior needs separate verification.

Run: python3 tests/verify-ui.py OUTPUT_DIRECTORY [--chromium-executable PATH]
Requires Playwright and an installed Chromium browser. The explicit option or
CHROMIUM_EXECUTABLE selects a binary; otherwise PATH is searched before using
Playwright's installed browser. Chromium's sandbox remains enabled.
"""
import argparse, functools, http.server, json, os, pathlib, tempfile, threading, shutil
from playwright.sync_api import sync_playwright
def chromium_launch_options(executable=None):
    requested = executable or os.environ.get("CHROMIUM_EXECUTABLE")
    if requested:
        binary = shutil.which(os.path.expanduser(requested))
        if binary is None:
            raise ValueError("Chromium executable was not found or is not executable: " + requested)
    else:
        binary = next((found for name in ("chromium", "chromium-browser", "google-chrome")
                       if (found := shutil.which(name))), None)
    options = {"headless": True, "chromium_sandbox": True}
    if binary is not None:
        options["executable_path"] = binary
    return options


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output_directory", type=pathlib.Path)
parser.add_argument("--chromium-executable", help="Chromium executable path or command name")
args = parser.parse_args()
try:
    launch_options = chromium_launch_options(args.chromium_executable)
except ValueError as error:
    parser.error(str(error))
root=pathlib.Path(__file__).resolve().parents[1]
out=args.output_directory.resolve();out.mkdir(parents=True,exist_ok=True)
temporary=tempfile.TemporaryDirectory()
for filename in ['importer.html','importer-ui.js','tag-filters.js']:
    shutil.copyfile(root/'js/plugins/devcel'/filename,pathlib.Path(temporary.name)/filename)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(http.server.SimpleHTTPRequestHandler,directory=temporary.name))
threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
    browser=p.chromium.launch(**launch_options)
    page=browser.new_page(viewport={'width':1000,'height':1150},device_scale_factor=1)
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.add_init_script('''window.saved=null;window.pulled=[];window.DevcelImporter={root:"C:/Games/日本語 Game",tagPresets:function(project){return Promise.resolve(project.indexOf("Other")>=0?["other"]:["release","mobile"]);},config:function(){return {schema_version:1,sources:[]};},save:function(v){window.saved=JSON.parse(JSON.stringify(v));return Promise.resolve({ok:true});},pull:function(id){window.pulled.push(id);return new Promise(function(resolve){setTimeout(function(){resolve({ok:true,data:{success:true}});},100);});},status:function(){return Promise.resolve({ok:true});},relativeProject:function(){return "../Authoring/Base.devcelproj.toml";}};''')
    page.goto(f'http://127.0.0.1:{server.server_port}/importer.html')
    page.get_by_role('button',name='Add configuration').click()
    page.get_by_label('Configuration ID',exact=True).fill('base')
    page.get_by_label('Namespace',exact=True).fill('Game.Base')
    page.get_by_label('Project').fill('../Authoring/Base.devcelproj.toml')
    page.get_by_label('Project').press('Tab')
    page.get_by_label('Add include rows tag',exact=True).select_option('release')
    page.get_by_label('Add exclude columns tag',exact=True).select_option('mobile')
    page.get_by_label('JSON output path').fill('data/devcel/base.json')
    page.get_by_label('Class name').fill('BaseData')
    page.get_by_label('Content Version',exact=True).fill('0')
    page.get_by_role('button',name='Reimport all',exact=True).click()
    assert 'Save settings' in page.locator('#result').inner_text()
    assert page.evaluate('window.pulled.length')==0
    page.get_by_role('button',name='Save settings',exact=True).click()
    page.wait_for_function('window.saved !== null')
    saved=page.evaluate('window.saved');assert saved['sources'][0]['version']==0
    assert saved['sources'][0]['class_name']=='BaseData'
    assert saved['sources'][0]['row_include_tags']==['release']
    assert saved['sources'][0]['column_exclude_tags']==['mobile']
    # A project switch must preserve unknown filters, with editable recovery.
    page.get_by_label('Project',exact=True).fill('../Other.devcelproj.toml')
    page.get_by_label('Project',exact=True).press('Tab')
    page.get_by_label('Include rows tag 1',exact=True).fill('other')
    page.get_by_label('Include rows tag 1',exact=True).press('Tab')
    page.wait_for_function("document.querySelector('[aria-label=\"Include rows tag 1\"]').tagName === 'SELECT'")
    assert page.get_by_label('Exclude columns tag 1',exact=True).input_value()=='mobile'
    page.get_by_role('button',name='Save settings',exact=True).click()
    page.wait_for_function('document.getElementById("all").disabled === false')
    assert page.evaluate('window.saved.sources[0].row_include_tags')==['other']
    assert page.evaluate('window.saved.sources[0].column_exclude_tags')==['mobile']
    page.get_by_role('button',name='Reimport this configuration',exact=True).click()
    assert page.get_by_role('button',name='Reimport all',exact=True).is_disabled()
    page.wait_for_function('document.getElementById("all").disabled === false')
    assert page.evaluate('window.pulled')==['base']
    page.get_by_role('button',name='Add configuration').click()
    assert page.locator('fieldset').count()==2
    page.get_by_role('button',name='Remove from settings',exact=True).nth(1).click()
    assert page.locator('fieldset').count()==1
    assert page.evaluate('window.pulled')==['base']
    page.get_by_role('button',name='Save settings',exact=True).click()
    page.wait_for_function('document.getElementById("all").disabled === false')
    page.screenshot(path=str(out/'rpgmaker-importer-ui.png'),full_page=True)
    assert not errors,errors
    (out/'ui-result.json').write_text(json.dumps({'ok':True,'dom_validation':True,'native_nwjs':False,'saved':saved},ensure_ascii=False,indent=2))
    browser.close()
server.shutdown();server.server_close();temporary.cleanup()
print(json.dumps({'ok':True,'dom_validation':True,'native_nwjs':False,'evidence':str(out)}))
