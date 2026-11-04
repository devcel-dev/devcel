-- Editor-only preset controls. Unknown persisted values remain visible until repaired or removed.
local M={}
M.keys={'row_include_tags','row_exclude_tags','column_include_tags','column_exclude_tags'}
local titles={'Include row tags','Exclude row tags','Include column tags','Exclude column tags'}
local function contains(values,value)
    for _,v in ipairs(values or {}) do if v==value then return true end end
    return false
end
local function changed(values,index,value)
    local result={}
    for i,v in ipairs(values) do if i~=index then result[#result+1]=v elseif value~=nil then result[#result+1]=value end end
    return result
end
M.controls=editor.ui.component(function(props)
    local children={editor.ui.label({text=titles[props.index]})}
    local values=props.values or {}
    for index,tag in ipairs(values) do
        local control
        if contains(props.presets,tag) then
            control=editor.ui.select_box({value=tag,options=props.presets,on_value_changed=function(value) props.set(changed(values,index,value)) end})
        else
            control=editor.ui.string_field({value=tag,enabled=props.presets~=nil,tooltip='Unregistered tag: repair to an exact preset name or remove. Press Enter to confirm.',on_value_changed=function(value) props.set(changed(values,index,value)) end})
        end
        children[#children+1]=editor.ui.horizontal({spacing=editor.ui.SPACING.SMALL,children={
            editor.ui.label({text=props.presets==nil and 'Saved tag' or (contains(props.presets,tag) and 'Preset' or 'Unregistered')}),control,
            editor.ui.button({text='Remove',on_pressed=function() props.set(changed(values,index,nil)) end})}})
    end
    local placeholder='Select preset…'
    while contains(props.presets,placeholder) do placeholder=placeholder..' ' end
    local options={placeholder}
    for _,tag in ipairs(props.presets or {}) do if not contains(values,tag) then options[#options+1]=tag end end
    children[#children+1]=editor.ui.select_box({value=options[1],options=options,enabled=#options>1,on_value_changed=function(value)
        if value==options[1] then return end
        local result=changed(values,0,nil);result[#result+1]=value;props.set(result)
    end})
    return editor.ui.vertical({spacing=editor.ui.SPACING.SMALL,children=children})
end)
return M
