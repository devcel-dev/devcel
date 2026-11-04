// Synthetic integration geometry only. It models the owner/extent contract, not CSS paint.
export function installPhysicalGridGeometry(window, { width, height, scrolls = [] }) {
  const proto = window.HTMLElement.prototype;
  const findDescriptor = name => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name); if (d) return d;
    }
  };
  const old = Object.fromEntries(['clientWidth','clientHeight','offsetWidth','offsetHeight','scrollWidth','scrollHeight','scrollTop','scrollLeft'].map(k => [k,findDescriptor(k)]));
  const previousRect = proto.getBoundingClientRect, previousScrollTo = proto.scrollTo;
  const fallback = (key, el, value) => old[key]?.get?.call(el) ?? value;
  const extentOfOwner = el => [...el.children].find(c => c.classList.contains('rdg-physical-extent'));
  const rootOf = el => el.classList.contains('rdg-physical-rows-viewport') ? el : el.closest('.rdg-physical-rows-viewport');
  const ownerOf = root => root?.closest('.rdg-physical-extent')?.parentElement;
  const offsets = new WeakMap();
  const getOffset = (el, key) => {
    if (!extentOfOwner(el)) return fallback(key, el, 0);
    const range = key === 'scrollTop' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    return Math.max(0, Math.min(offsets.get(el)?.[key] ?? 0, range));
  };
  const pending = new WeakSet();
  const schedule = el => { if (!pending.has(el)) { pending.add(el); queueMicrotask(() => { pending.delete(el); if(el.isConnected)el.dispatchEvent(new window.Event('scroll')); }); } };
  Object.defineProperties(proto, {
    clientWidth: { configurable:true, get() { if(extentOfOwner(this))return width; if(this.classList.contains('rdg-physical-rows-viewport'))return Number.parseFloat(this.style.width)||0; return fallback('clientWidth',this,width); } },
    clientHeight: { configurable:true, get() { if(extentOfOwner(this))return height; if(this.classList.contains('rdg-physical-rows-viewport'))return Number.parseFloat(this.style.height)||0; return fallback('clientHeight',this,height); } },
    offsetWidth: { configurable:true, get() {
      const root=rootOf(this);
      if(root && this.hasAttribute('data-measuring-cell-key')) {
        const columns=root.hasAttribute('data-rdg-measuring') ? root.style.getPropertyValue('--rdg-measure-columns') : this.parentElement.style.gridTemplateColumns;
        const token=columns.split(/\s+/)[Number(this.style.gridColumnStart)-1];
        return token==='max-content'?246:Number.parseFloat(token)||0;
      }
      return root?.isSameNode(this)?this.clientWidth:fallback('offsetWidth',this,width);
    } },
    offsetHeight: { configurable:true,get(){return rootOf(this)?.isSameNode(this)?this.clientHeight:fallback('offsetHeight',this,height);} },
    scrollWidth: { configurable:true,get(){const e=extentOfOwner(this);return e?Math.max(this.clientWidth,Number.parseFloat(e.style.width)||0):fallback('scrollWidth',this,this.clientWidth);} },
    scrollHeight: { configurable:true,get(){const e=extentOfOwner(this);return e?Math.max(this.clientHeight,Number.parseFloat(e.style.height)||0):fallback('scrollHeight',this,this.clientHeight);} },
    scrollTop: { configurable:true,get(){return getOffset(this,'scrollTop');},set(v){if(!extentOfOwner(this)){old.scrollTop?.set?.call(this,v);return;}offsets.set(this,{...offsets.get(this),scrollTop:v});} },
    scrollLeft: { configurable:true,get(){return getOffset(this,'scrollLeft');},set(v){if(!extentOfOwner(this)){old.scrollLeft?.set?.call(this,v);return;}offsets.set(this,{...offsets.get(this),scrollLeft:v});} }
  });
  proto.getBoundingClientRect=function(){
    if(this.classList.contains('rdg-physical-extent')) {
      const owner=this.parentElement;
      return new window.DOMRect(-owner.scrollLeft,-owner.scrollTop,Number.parseFloat(this.style.width)||0,Number.parseFloat(this.style.height)||0);
    }
    const root=rootOf(this),owner=ownerOf(root);
    if(root===this&&root.classList.contains('rdg-stationary-rows-viewport'))return new window.DOMRect(0,0,this.clientWidth,this.clientHeight);
    return owner?new window.DOMRect(-owner.scrollLeft,-owner.scrollTop,this.clientWidth,this.clientHeight):previousRect.call(this);
  };
  proto.scrollTo=function(options,y){const extent=extentOfOwner(this);if(!extent)return previousScrollTo.call(this,options,y);const request=typeof options==='object'?options:{left:options,top:y};const root=extent.querySelector('.rdg-physical-rows-viewport');const content=root?.classList.contains('rdg-stationary-rows-viewport')?extent:root;const before=content?.getBoundingClientRect();const origin=before?[this.scrollLeft+before.left,this.scrollTop+before.top]:null;this.scrollLeft=request.left??this.scrollLeft;this.scrollTop=request.top??this.scrollTop;const after=content?.getBoundingClientRect();if(origin&&after&&(Math.abs(this.scrollLeft+after.left-origin[0])>1e-7||Math.abs(this.scrollTop+after.top-origin[1])>1e-7))throw Error('physical scroll changed content origin');scrolls.push({kind:'physical-owner',owner:this,root,left:this.scrollLeft,top:this.scrollTop});schedule(this);};
  return { ownerOf, extentOfOwner };
}
