-- Devcel canonical schema v1. No native extension, external Lua package or P2P dependency.
-- Every load builds a complete candidate before replacing the current snapshot.
local M = {}
local limits = {
    U8={"0","255"}, I8={"-128","127"}, U16={"0","65535"}, I16={"-32768","32767"},
    U32={"0","4294967295"}, I32={"-2147483648","2147483647"},
    U64={"0","18446744073709551615"}, I64={"-9223372036854775808","9223372036854775807"}
}
local texts = {None=true, String=true, Select=true, DateTime=true, Reference=true, TableRef=true}
local function copy(v)
    if type(v) ~= "table" then return v end
    local r = {}; for k, x in pairs(v) do r[k] = copy(x) end; return r
end
local function name(v) return type(v)=="string" and #v>0 end
local function finite(v) return type(v)=="number" and v==v and v~=math.huge and v~=-math.huge end
local function whole(v) return finite(v) and v==math.floor(v) end
local function null(v) return v==nil or (json.null~=nil and v==json.null) end
local function array(v, label)
    assert(type(v)=="table", label.." must be an array")
    local n=0; for k in pairs(v) do assert(whole(k) and k>=1 and k<=#v, label.." must be an array"); n=n+1 end
    assert(n==#v, label.." has gaps"); return v
end
local function object(v, label)
    assert(type(v)=="table",label.." must be an object")
    for k in pairs(v) do assert(type(k)=="string",label.." must be an object") end
    return v
end
local function integer(raw)
    raw=raw:match("^%s*(.-)%s*$")
    if raw=="" then raw="0" end
    assert(raw:match("^[+-]?%d+$"),"invalid integer")
    local neg=raw:sub(1,1)=="-"
    local digits=raw:gsub("^[+-]",""):gsub("^0+","")
    if digits=="" then digits="0" end
    return (neg and digits~="0" and "-" or "")..digits
end
local function compare(a,b)
    local an,bn=a:sub(1,1)=="-",b:sub(1,1)=="-"
    if an~=bn then return an and -1 or 1 end
    local x,y=an and a:sub(2) or a,bn and b:sub(2) or b
    local s=an and -1 or 1
    if #x~=#y then return #x<#y and -s or s end
    if x==y then return 0 end
    return x<y and -s or s
end
local function number(raw)
    raw=raw:match("^%s*(.-)%s*$"); if raw=="" then raw="0" end
    -- Reject hex, inf/nan and trailing garbage while accepting signed decimal/exponent notation.
    assert(raw:match("^[+-]?%d*%.?%d+[eE]?[+-]?%d*$") or raw:match("^[+-]?%d+%.$"),"invalid decimal")
    local value=tonumber(raw); assert(finite(value),"finite decimal required"); return value
end
local function decode(raw,col)
    assert(type(raw)=="string","canonical cells must be strings")
    local kind=col.data_type
    if limits[kind] then
        local n=integer(raw); local range=limits[kind]
        assert(compare(n,range[1])>=0 and compare(n,range[2])<=0,"out of "..kind.." range")
        -- Lua/JS number precision cannot represent every 64-bit integer. Never round them.
        return (kind=="I64" or kind=="U64") and n or tonumber(n), n
    elseif kind=="F32" or kind=="F64" then
        local n=number(raw); assert(kind~="F32" or math.abs(n)<=3.4028234663852886e38,"F32 overflow")
        return n,raw
    elseif kind=="Boolean" then
        local s=raw:match("^%s*(.-)%s*$"):lower(); if s=="" then s="false" end
        assert(s=="true" or s=="false","Boolean requires true/false"); return s=="true",s
    elseif kind=="Color32" or kind=="ColorFloat" then
        if kind=="Color32" then
            assert(raw:match("^%s*%[%s*%d+%s*,%s*%d+%s*,%s*%d+%s*,%s*%d+%s*%]%s*$"),"Color32 requires four unsigned JSON integers")
        end
        local v=array(json.decode(raw,{decode_null_as_userdata=true}),kind); assert(#v==4,kind.." requires four channels")
        for i,x in ipairs(v) do
            assert(finite(x),"finite color channel required")
            if kind=="Color32" then assert(whole(x) and x>=0 and x<=255,"Color32 channel outside 0..255")
            else assert(math.abs(x)<=3.4028234663852886e38,"ColorFloat overflow"); if i==4 then assert(x>=0 and x<=1,"alpha outside 0..1") end end
        end
        -- Straight alpha. Do not clamp RGB, convert gamma, or premultiply transparent RGB.
        return {r=v[1],g=v[2],b=v[3],a=v[4]},raw
    elseif kind=="Curve" then
        local cfg=col.curve_config or {}
        if raw=="" then return {points={},start_value=cfg.start_value or 0,end_value=cfg.end_value or 1},raw end
        local curve=object(json.decode(raw,{decode_null_as_userdata=true}),"Curve")
        array(curve.points,"Curve.points")
        for _,p in ipairs(curve.points) do
            assert(type(p)=="table" and finite(p.x) and finite(p.y),"invalid curve point")
        end
        return curve,raw
    end
    assert(texts[kind],"unknown data_type: "..tostring(kind)); return raw,raw
end
local function default(kind)
    if kind=="Color32" then return "[255,255,255,255]" end
    if kind=="ColorFloat" then return "[1,1,1,1]" end
    return ""
end
local Table,Row={},{}; Table.__index=Table; Row.__index=Row
local function table_view(snapshot,t) return t and setmetatable({_snapshot=snapshot,_data=t},Table) or nil end
local function row_view(snapshot,t,r) return r and setmetatable({_snapshot=snapshot,_table=t,_data=r},Row) or nil end
function Table:name() return self._data.name end
function Table:uuid() return self._data.uuid end
function Table:count() return #self._data.ids end
function Table:ids() return copy(self._data.ids) end
function Table:columns() return copy(self._data.column_order) end
function Table:column_info(col) return copy(self._data.columns[col]) end
function Table:by_id(id) return row_view(self._snapshot,self._data,self._data.records[id]) end
function Table:at(index) return self:by_id(self._data.ids[index]) end -- Lua indices are 1-based.
function Row:id() return self._data.id end
function Row:get_raw(col) return self._data.raw[col] end
function Row:get(col) return copy(self._data.typed[col]) end
function Row:reference(col)
    local c=self._table.columns[col]; assert(c and c.data_type=="Reference","Reference column required")
    local t=self._snapshot.by_uuid[(c.reference_config or {}).target_table_uuid]
    return t and row_view(self._snapshot,t,t.records[self:get_raw(col)]) or nil
end
function Row:table_reference(col)
    local c=self._table.columns[col]; assert(c and c.data_type=="TableRef","TableRef column required")
    local t=self._snapshot.by_uuid[self:get_raw(col)]; if not t then return nil end
    local required=(c.table_ref_config or {}).interface_uuid
    if name(required) then
        local found=false; for _,id in ipairs(t.interfaces) do if id==required then found=true end end
        if not found then return nil end
    end
    return table_view(self._snapshot,t)
end
local function parse(text)
    local b=object(json.decode(text,{decode_null_as_userdata=true}),"bundle"); local m=object(b.manifest,"manifest")
    assert(m.schema_version==1,"schema_version 1 required")
    assert(name(m.content_hash) and name(m.generated_at),"invalid manifest")
    assert(whole(m.data_revision) and m.data_revision>=0,"invalid data_revision")
    assert(null(m.content_version) or (whole(m.content_version) and m.content_version>=0 and m.content_version<=4294967295),"invalid content_version")
    assert(m.mode=="full" or m.mode=="minimal","invalid export mode")
    assert(type(b.project_name)=="string","project_name must be a string")
    local s={manifest=copy(m),project_name=b.project_name,tables={},by_uuid={},names={}}
    for _,source in ipairs(array(b.tables,"tables")) do
        assert(type(source)=="table" and name(source.name) and name(source.uuid),"table name/uuid required")
        assert(not s.tables[source.name] and not s.by_uuid[source.uuid],"duplicate table name/uuid")
        local t={name=source.name,uuid=source.uuid,interfaces=copy(source.interfaces or {}),columns={},column_order={},records={},ids={}}
        for _,id in ipairs(array(t.interfaces,"interfaces")) do assert(name(id),"invalid interface UUID") end
        local plans={}
        for _,col in ipairs(array(source.columns,"columns")) do
            assert(type(col)=="table" and name(col.name) and not t.columns[col.name],"invalid/duplicate column")
            local c=copy(col)
            assert(limits[c.data_type] or texts[c.data_type] or c.data_type=="F32" or c.data_type=="F64" or c.data_type=="Boolean" or c.data_type=="Curve" or c.data_type=="Color32" or c.data_type=="ColorFloat","unknown data_type")
            for _,key in ipairs({"reference_config","table_ref_config","curve_config"}) do
                if null(c[key]) then c[key]=nil elseif c[key]~=nil then object(c[key],key) end
            end
            local plan={column=c,raw=default(c.data_type),ready=false}
            if not null(c.default_value) then
                assert(type(c.default_value)=="string","default_value must be a string")
                plan.raw=c.default_value; plan.value,plan.normalized=decode(plan.raw,c); plan.ready=true
            else c.default_value=nil end
            plans[c.name]=plan
            t.columns[c.name]=c; t.column_order[#t.column_order+1]=c.name
        end
        for _,record in ipairs(array(source.records,"records")) do
            assert(type(record)=="table" and name(record.id) and not t.records[record.id],"invalid/duplicate record id")
            local values=object(record.values,"record.values")
            for key,v in pairs(values) do
                assert(t.columns[key]~=nil,"unknown column in record.values: "..key)
                assert(type(v)=="string","canonical cells must be strings")
            end
            local r={id=record.id,raw={},typed={}}
            for _,colname in ipairs(t.column_order) do
                local plan=plans[colname]; local raw=values[colname]
                if raw~=nil and raw~=plan.raw then
                    r.typed[colname],r.raw[colname]=decode(raw,plan.column)
                else
                    if not plan.ready then plan.value,plan.normalized=decode(plan.raw,plan.column); plan.ready=true end
                    -- Each row owns its mutable Color/Curve tables, including nested points.
                    r.typed[colname],r.raw[colname]=copy(plan.value),plan.normalized
                end
            end
            t.records[r.id]=r; t.ids[#t.ids+1]=r.id
        end
        s.tables[t.name]=t; s.by_uuid[t.uuid]=t; s.names[#s.names+1]=t.name
    end
    return s
end
local Database={}; Database.__index=Database
function M.new(source_id) return setmetatable({source_id=source_id or "default",last_error="",_elapsed=0,_generation=0},Database) end
function Database:load_json(text)
    local ok,candidate=pcall(parse,text)
    if not ok then self.last_error=tostring(candidate); return false,self.last_error end
    self._snapshot=candidate; self._bytes=text; self._reader=nil; self._path=nil; self.last_error=""; return true
end
function Database:_load(reader,path)
    local ok,text=pcall(reader,path)
    if not ok or type(text)~="string" then self.last_error=tostring(text or "resource missing: "..path); return false,self.last_error end
    if self._bytes==text then self.last_error=""; return true,false end
    local loaded,err=self:load_json(text)
    if loaded then self._reader=reader; self._path=path end
    return loaded,loaded and true or err
end
local function read_file(path)
    local f,err=io.open(path,"rb"); assert(f,err); local text=f:read("*a"); f:close(); return text
end
function Database:load_resource(path)
    local ok,changed=self:_load(sys.load_resource,path)
    if ok then self._reader=sys.load_resource; self._path=path end
    return ok,changed
end
-- Native desktop development only. Bundled/release builds should use load_resource.
function Database:load_file(path)
    local ok,changed=self:_load(read_file,path)
    if ok then self._reader=read_file; self._path=path end
    return ok,changed
end
function Database:reload_if_changed()
    if not self._reader then self.last_error="load_file/load_resource first"; return false,self.last_error end
    return self:_load(self._reader,self._path)
end
function Database:table(name_) return self._snapshot and table_view(self._snapshot,self._snapshot.tables[name_]) or nil end
function Database:table_by_uuid(uuid) return self._snapshot and table_view(self._snapshot,self._snapshot.by_uuid[uuid]) or nil end
function Database:by_id(table_name,id) local t=self:table(table_name); return t and t:by_id(id) or nil end
function Database:tables() return self._snapshot and copy(self._snapshot.names) or {} end
function Database:manifest() return self._snapshot and copy(self._snapshot.manifest) or nil end
function Database:project_name() return self._snapshot and self._snapshot.project_name or "" end
function Database:watch_file(path,interval,callback)
    assert(sys.get_engine_info().is_debug,"watch_file is for debug builds only")
    assert(finite(interval) and interval>=0.25,"interval must be >= 0.25 seconds")
    local ok,err=self:load_file(path); if not ok then return false,err end
    self:stop_watch(); self._interval=interval; self._callback=callback; return true
end
function Database:watch_http(url,interval,callback)
    assert(sys.get_engine_info().is_debug,"watch_http is for debug builds only")
    assert(type(url)=="string" and url:match("^http://127%.0%.0%.1:%d+/runtime/[%w_-]+%?token=[%w_-]+$"),"paste the loopback runtime URL from importer UI")
    assert(finite(interval) and interval>=0.25,"interval must be >= 0.25 seconds")
    self:stop_watch(); self._url=url; self._interval=interval; self._callback=callback; return true
end
function Database:stop_watch()
    self._generation=self._generation+1; self._url=nil; self._interval=nil; self._pending=false; self._elapsed=0; self._callback=nil
end
function Database:update(dt)
    if not self._interval then return end
    self._elapsed=self._elapsed+dt; if self._elapsed<self._interval or self._pending then return end
    self._elapsed=0
    if not self._url then
        local ok,changed=self:reload_if_changed(); if self._callback then self._callback(self,ok,changed) end; return
    end
    self._pending=true; local generation=self._generation
    http.request(self._url,"GET",function(_,_,response)
        if generation~=self._generation then return end -- Ignore callbacks from a stopped/reconfigured source.
        self._pending=false
        local ok,changed=false,false
        if response.status==200 and type(response.response)=="string" then
            if self._bytes==response.response then ok=true; self.last_error=""
            else ok=self:load_json(response.response); changed=ok end
        else self.last_error="Devcel live HTTP status "..tostring(response.status) end
        if self._callback then self._callback(self,ok,changed) end
    end,{},nil,{timeout=5})
end
return M
