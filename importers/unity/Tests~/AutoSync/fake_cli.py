#!/usr/bin/python3
import sys,json,os,time
args=sys.argv[1:]
assert args != ['--version'], 'version probe must not run'
if args==['--help']:
 print('Usage: devcel\n  pull\n  watch');sys.exit()
if args==['watch','--help']:
 print('--ensure-server\n--parent-stdin');sys.exit()
p=args[args.index('--project')+1]
assert args[-3:]==['watch','--ensure-server','--parent-stdin'],args
root=os.environ['QA_ROOT'];mode=os.path.basename(p)
with open(root+'/starts.jsonl','a') as f:f.write(json.dumps({'pid':os.getpid(),'project':p,'args':args})+'\n')
if mode=='failure':
 print(json.dumps({'ok':False,'error':{'kind':'text','text':'fixture bind denied: '+('x'*300)}}),flush=True)
 print('stderr detail preserved',file=sys.stderr,flush=True);sys.exit(7)
if mode not in ['hang']:
 print(json.dumps({'event':'connected'}),flush=True)
 time.sleep(.06)
 if mode=='flap':
  print(json.dumps({'event':'disconnected'}),flush=True)
 else:print(json.dumps({'event':'snapshot','project_state':{}}),flush=True)
sys.stdin.buffer.read()
with open(root+'/eof.jsonl','a') as f:f.write(json.dumps({'pid':os.getpid(),'project':p})+'\n')
