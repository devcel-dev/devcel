use devcel_core::formula_engine::BUILTIN_FUNCTIONS;
use devcel_core::{FormulaEngine, FormulaError, Record, TableSchema};
use std::collections::BTreeSet;

#[test]
fn every_completion_builtin_is_dispatched_by_the_real_evaluator() {
    let mut names = BTreeSet::new();
    for name in BUILTIN_FUNCTIONS {
        assert!(names.insert(*name), "duplicate builtin {name}");
        let result = FormulaEngine::new()
            .evaluate(
                &format!("={name}()"),
                "result",
                &Record::new(),
                &TableSchema { columns: vec![] },
            )
            .into_result();
        assert!(
            !matches!(result, Err(FormulaError::FunctionNotFound(_))),
            "completion advertises missing function {name}"
        );
    }
}

#[test]
fn completion_catalog_tracks_all_native_dispatch_names() {
    let scalar = include_str!("../src/formula_engine.rs");
    let scalar = scalar.split("    fn evaluate_function(").nth(1).unwrap();
    let scalar = scalar.split("    fn func_curve(").next().unwrap();
    let collection = include_str!("../src/formula_collections.rs");
    let collection = collection.split("    fn call(").nth(1).unwrap();
    let collection = collection.split("    fn join_push(").next().unwrap();
    let pattern = regex::Regex::new(r#""([A-Z][A-Z0-9_]*)""#).unwrap();
    let names: BTreeSet<_> = pattern
        .captures_iter(scalar)
        .chain(pattern.captures_iter(collection))
        .map(|capture| capture[1].to_owned())
        // These are JOIN mode literals, not callable names.
        .filter(|name| name != "INNER" && name != "LEFT")
        .collect();
    assert_eq!(
        names,
        BUILTIN_FUNCTIONS.iter().map(|s| (*s).to_owned()).collect()
    );
}
