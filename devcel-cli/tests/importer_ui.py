#!/usr/bin/env python3
"""Exercise the real bundled loopback UI: portability, CSRF and non-destructive failure."""
import json, pathlib, subprocess, sys, urllib.request, urllib.error, socket
cli=pathlib.Path(sys.argv[1]).resolve(); root=pathlib.Path(sys.argv[2]).resolve(); root.mkdir(parents=True,exist_ok=False)
def command(*args):
 p=subprocess.run([str(cli),*map(str,args)],capture_output=True,text=True); assert p.returncode==0,p.stderr+p.stdout; return json.loads(p.stdout)['data']
project=pathlib.Path(command('init','Master','--dir',root/'authoring')['project_path'])
command('--mode','local','--project',project,'table','create','Items')
title=root/'title'; title.mkdir()
proc=subprocess.Popen([str(cli),'importer-ui','--root',str(title),'--engine','gamemaker','--no-open'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 info=json.loads(proc.stdout.readline())['data']; base,token=info['url'].split('#'); base=base.rstrip('/')
 def request(path,body=None,token_value=token,origin=None):
  headers={'X-Devcel-Token':token_value,'Content-Type':'application/json'}
  if origin: headers['Origin']=origin
  req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=15) as response: return response.status,response.read()
  except urllib.error.HTTPError as error: return error.code,error.read()
 assert request('/api/config')[0]==200
 assert request('/api/config',token_value='wrong')[0]==403
 assert request('/api/config',origin='https://evil.example')[0]==403
 cfg={'schema_version':1,'sources':[{'id':'base','project':'../authoring/Master/Master.devcelproj.toml','namespace':'Game.Base','class_name':'BaseData','mode':'full','version':0,'runtime_out':'datafiles/devcel/base.json','code_out':None,'code_target':None}]}
 cfg['sources'][0]['project']=__import__('os').path.relpath(project,title)
 assert request('/api/config',{'config':cfg,'revision':'missing'})[0]==200
 assert json.loads((title/'devcel.import.json').read_text())==cfg
 status,data=request('/api/pull',{'source':'base'}); assert status==200,data
 runtime=title/'datafiles/devcel/base.json'; before=runtime.read_bytes(); assert json.loads(before)['tables']
 assert request('/runtime/base')[0]==200
 assert request('/runtime/../devcel.import.json')[0]!=200
 assert request('/runtime/base?token='+token,token_value='')[0]==200
 saved=(title/'devcel.import.json').read_bytes()
 assert request('/api/config',{'config':cfg,'revision':'missing'})[0]==400
 bad=json.loads(json.dumps(cfg)); bad['sources'].append(dict(bad['sources'][0]))
 assert request('/api/config',{'config':bad,'revision':json.loads(request('/api/config')[1])['revision']})[0]==400
 assert (title/'devcel.import.json').read_bytes()==saved and runtime.read_bytes()==before
 bad=json.loads(json.dumps(cfg)); bad['sources'][0]['runtime_out']=str(project)
 assert request('/api/config',{'config':bad,'revision':json.loads(request('/api/config')[1])['revision']})[0]==400
 assert (title/'devcel.import.json').read_bytes()==saved
 assert request('/api/status',{'source':'base'})[0]==200
 assert request('/api/pull',{'source':'missing'})[0]==400
 assert runtime.read_bytes()==before
 # HTTP Host enforcement prevents DNS rebinding even with a leaked token.
 address=base.split('://')[1]; host,port=address.split(':')
 with socket.create_connection((host,int(port)),timeout=5) as conn:
  conn.sendall(f'GET /api/config HTTP/1.1\r\nHost: attacker.example\r\nX-Devcel-Token: {token}\r\n\r\n'.encode()); assert b'403' in conn.recv(1024)
 with socket.create_connection((host,int(port)),timeout=5) as conn:
  conn.sendall(f'POST /api/config HTTP/1.1\r\nHost: {address}\r\nContent-Length: 18446744073709551615\r\n\r\n'.encode()); assert b'403' in conn.recv(1024)
 assert request('/api/config')[0]==200
 print(json.dumps({'passed':True,'checks':['config-relative-paths','full-local-pull','version-zero','status','csrf-token','foreign-origin','host','runtime-allowlist','invalid-config-keeps-old','failed-pull-keeps-old']}))
finally:
 proc.terminate(); proc.wait(timeout=10)
