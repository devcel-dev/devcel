@tool
extends RefCounted
## Editor text follows Godot's editor language; serialized values remain unchanged.
static func text(japanese: String, english: String) -> String:
	return japanese if TranslationServer.get_tool_locale().begins_with("ja") else english
