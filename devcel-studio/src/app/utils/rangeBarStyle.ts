import type { CSSProperties } from 'react';
import type { RangeBar } from '@/app/types/tableRules';

const valid = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const rgb = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
const luminance = (value: string) => rgb(value).map(v => { const n=v/255; return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4; }).reduce((v,n,i)=>v+n*[0.2126,0.7152,0.0722][i],0);
const contrast = (a: string,b: string) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
/** Rust owns evaluation. This shared grid/preview renderer only draws its transport. */
export function rangeBarStyle(bar: RangeBar | undefined, direction: 'ltr' | 'rtl', requestedText?: string): CSSProperties | undefined {
  if (!bar || !valid(bar.color) || !Number.isFinite(bar.fraction)) return undefined;
  const fraction=Math.max(0,Math.min(10000,bar.fraction))/100;
  // A pale track and bar keep one foreground readable over both halves, in either theme.
  const fill=bar.out_of_range?bar.color:'#'+rgb(bar.color).map(v=>Math.round(v*0.4+255*0.6).toString(16).padStart(2,'0')).join('');
  const surfaces=bar.out_of_range?[fill]:[fill,'#ffffff'];
  const safe=(color: string)=>valid(color)&&surfaces.every(surface=>contrast(color,surface)>=4.5);
  const color=requestedText&&safe(requestedText)?requestedText:safe('#111111')?'#111111':'#ffffff';
  return { backgroundColor: bar.out_of_range?fill:'#ffffff', color,
    backgroundImage: bar.out_of_range?'none':`linear-gradient(to ${direction==='rtl'?'left':'right'}, ${fill} 0%, ${fill} ${fraction}%, transparent ${fraction}%, transparent 100%)` };
}
