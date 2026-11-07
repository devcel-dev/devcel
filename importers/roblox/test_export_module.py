import json
import unittest
from export_module import render

class ExportTests(unittest.TestCase):
    def test_json_is_data_even_with_long_bracket_delimiters(self):
        source = json.dumps({"manifest": {"schema_version": 1, "mode": "full"},
                             "tables": [{"name": "]] ]=] \" quote"}]})
        module = render(source)
        self.assertIn("[==[\n" + source + "]==]", module)
        self.assertIn("HttpService:JSONDecode", module)

    def test_rejects_unsupported_and_malformed_inputs(self):
        for source in ('{}', '{', '{"manifest":{"schema_version":2,"mode":"full"},"tables":[]}'):
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                render(source)

if __name__ == "__main__":
    unittest.main()
