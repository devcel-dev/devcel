const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('assert/strict');
const { compileModule } = require('./compile-module.cjs');
const root=path.resolve(__dirname,'..');let checks=0;
// Use the real generated Japanese catalog and ICU for translation. Mock only React subscriptions at the local fixture boundary.
const {IntlMessageFormat}=require('intl-messageformat');
const jaMessages=JSON.parse(fs.readFileSync(path.join(root,'src/app/i18n/generated/catalog.json'),'utf8')).messages.ja;
const messageFormats=new Map();
function t(key,values){assert.ok(Object.prototype.hasOwnProperty.call(jaMessages,key),'Missing Japanese message: '+key);if(!messageFormats.has(key))messageFormats.set(key,new IntlMessageFormat(jaMessages[key],'ja',undefined,{ignoreTag:true}));return String(messageFormats.get(key).format(values));}
const i18n={t,useI18n:()=>({locale:'ja',t}),formatNumber:(value,options)=>new Intl.NumberFormat('ja',options).format(value)};
function load(file,mocks={}){const m=new Module(file);m.paths=Module._nodeModulePaths(root);m.require=(id)=>id in mocks?mocks[id]:id==='@/app/i18n'?i18n:require(id);m._compile(compileModule(fs.readFileSync(file,'utf8'), file),file);return m.exports;}
const curve=load(path.join(root,'src/app/utils/curve.ts'));function check(v){assert.ok(v);checks++;}
for(const s of ['{"points":[null,null]}','{"points":[{},{}]}','{"points":[{"x":0,"y":0,"mode":"bad"},{"x":1,"y":1}]}','{"points":[{"x":0,"y":0,"outLen":4},{"x":1,"y":1}]}','{"points":[{"x":0,"y":0},{"x":0,"y":1},{"x":1,"y":1}]}'])check(curve.parseCurve(s)===null);
check(curve.parseCurve('{"points":[{"x":0,"y":0},{"x":1,"y":1}]}')===null);
check(curve.parseCurve('{"points":[{"x":0,"y":0,"mode":"auto"},{"x":1,"y":1,"mode":"auto"}]}').points[0].mode==='auto');
for(const preset of curve.EASING_PRESETS){const data=preset.build(-2,3);check(!!curve.parseCurve(curve.serializeCurve(data)));check(curve.evaluateCurve(data,0)===-2);check(curve.evaluateCurve(data,1)===3);for(const x of [.1,.25,.5,.75,.9])check(Number.isFinite(curve.evaluateCurve(data,x)));}
const smooth=curve.EASING_PRESETS.find(p=>p.id==='smoothstep').build(0,1);check(Math.abs(curve.evaluateCurve(smooth,.25)-.15625)<1e-8);
const step={points:[{x:0,y:0,mode:'constant'},{x:.5,y:1,mode:'constant'},{x:1,y:2,mode:'auto'}]};check(curve.evaluateCurve(step,.499)===0);check(curve.evaluateCurve(step,.5)===1);check(curve.evaluateCurve(step,1)===2);
// Exact inversion roots must not drift away from an already solved midpoint/knot.
for(const mode of ['auto','linear','free']){
 const data={points:[{x:0,y:10,mode},{x:1,y:30,mode}]};
 check(curve.evaluateCurve(data,.5)===20);
}
const knot={points:[{x:0,y:10,mode:'linear'},{x:.4,y:20,mode:'linear'},{x:1,y:30,mode:'linear'}]};
check(curve.evaluateCurve(knot,.4)===20);
let state=[],cursor=0;const react={useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useRef(initial){const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i];}};
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};const dialog={Dialog:'Dialog',DialogContent:'DialogContent',DialogTrigger:'DialogTrigger',DialogTitle:'DialogTitle'};
const cell=load(path.join(root,'src/app/pages/main_window/project_view/table_view/components/CurveCell.tsx'),{'react':react,'react/jsx-runtime':jsx,'@/components/ui/dialog':dialog,'lucide-react':{ChevronDown:'ChevronDown'},'@/app/utils/curve':curve,'./CurveEditor':{CurveEditor:'CurveEditor'}});
function all(e){if(!e||typeof e!=='object')return[];return[e,...[e.props?.children].flat(Infinity).flatMap(all)];}
function scenario(action){state=[];let writes=[],closes=[];const original=curve.serializeCurve(curve.defaultCurve(0,1));const props={column:{key:'curve'},columnData:{curve_config:{start_value:0,end_value:1}},row:{curve:original},onRowChange:(...a)=>writes.push(a),onClose:(...a)=>closes.push(a)};
 const render=()=>{cursor=0;return cell.CurveCellEditor(props);};let tree=render();const draft=curve.EASING_PRESETS.find(p=>p.id==='step').build(0,1);const content=all(tree).find(e=>e.type==='DialogContent');check(content.props.className.includes('max-w-[calc(100vw-24px)]')&&content.props.className.includes('max-h-[calc(100dvh-24px)]')&&content.props.className.includes('overflow-auto'));all(tree).find(e=>e.type==='CurveEditor').props.onChange(draft);check(writes.length===0);tree=render();action(all(tree),tree);return {writes,closes,draft};}
let result=scenario(elements=>elements.find(e=>e.type==='button'&&e.props.children==='適用').props.onClick());check(result.writes.length===1&&result.writes[0][1]===true);check(JSON.parse(result.writes[0][0].curve).points[0].mode==='constant');
result=scenario(elements=>elements.find(e=>e.type==='DialogContent').props.onEscapeKeyDown({preventDefault(){},stopPropagation(){}}));check(result.writes.length===0&&result.closes.length===1&&result.closes[0][0]===false);
result=scenario(elements=>elements.find(e=>e.type==='button'&&e.props.children==='キャンセル').props.onClick());check(result.writes.length===0&&result.closes[0][0]===false);
result=scenario((elements,tree)=>tree.props.onOpenChange(false));check(result.writes.length===0&&result.closes[0][0]===false);
console.log(`Curve math/parser/editor: ${checks} checks passed`);
