import copy
import unittest
from generate import generate

class GenerateTests(unittest.TestCase):
    def setUp(self):
        self.bundle = {"manifest": {"schema_version": 1, "mode": "full"}, "tables": [
            {"name": "enemies", "uuid": "11111111-1111-4111-8111-111111111111", "columns": [
                {"name": "name", "data_type": "String"},
                {"name": "health", "data_type": "I32", "default_value": "10"},
            ], "records": []}]}

    def test_generates_types_and_checks_schema_even_for_empty_tables(self):
        output = generate(self.bundle)
        self.assertIn("Permission is hereby granted", output)
        self.assertIn("Copyright (c) 2024 Devcel Studio Contributors", output)
        self.assertIn('public string Value_name', output)
        self.assertIn('public int Value_health', output)
        self.assertLess(output.index('schema.TryGetValue("health"'), output.index('foreach (var value in records)'))
        self.assertIn('defaults["health"] != "10"', output)
        self.assertIn('Guid.TryParse(row.RecordId', output)

    def test_rejects_future_versions_duplicates_and_invalid_names(self):
        for mutate in (
            lambda b: b["manifest"].update(schema_version=2),
            lambda b: b["manifest"].update(schema_version=True),
            lambda b: b["tables"].append(copy.deepcopy(b["tables"][0])),
            lambda b: b["tables"][0]["columns"][0].update(name='x; dangerous'),
            lambda b: b["tables"][0]["columns"][0].update(data_type='Unknown'),
            lambda b: b["tables"][0]["columns"][0].update(default_value=0),
        ):
            b = copy.deepcopy(self.bundle); mutate(b)
            with self.assertRaises(ValueError): generate(b)

if __name__ == "__main__": unittest.main()
