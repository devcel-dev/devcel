//! Canonical authoring ABI workflow. Runtime's separate read-only ABI is unchanged.
#![cfg(feature = "ffi")]

use devcel_core::{
    ffi::{devcel_free, devcel_free_string},
    ffi_unified::*,
    operations::{DevcelOperation, DevcelResponse},
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};

fn execute_json(operation: Value) -> Value {
    let input = CString::new(operation.to_string()).unwrap();
    unsafe {
        let output = devcel_execute_json(input.as_ptr());
        assert!(!output.is_null());
        let response = serde_json::from_slice(CStr::from_ptr(output).to_bytes()).unwrap();
        devcel_free_string(output);
        response
    }
}

fn execute_messagepack(operation: DevcelOperation) -> DevcelResponse {
    let input = rmp_serde::to_vec_named(&operation).unwrap();
    let mut len = usize::MAX;
    unsafe {
        let output = devcel_execute(input.as_ptr(), input.len(), &mut len);
        assert!(!output.is_null());
        let response = rmp_serde::from_slice(std::slice::from_raw_parts(output, len)).unwrap();
        devcel_free(output, len);
        response
    }
}

#[test]
fn canonical_json_and_messagepack_share_a_safe_authoring_session() {
    let dir = tempfile::tempdir().unwrap();
    devcel_init();
    let response = execute_json(json!({"op":"CreateProject","data":{
        "project_name":"Authoring ABI", "project_path":dir.path(),
        "description":"UTF-8 日本語", "header_color":"#123456"
    }}));
    assert_eq!(response["status"], "Ok", "{response}");
    let info = execute_messagepack(DevcelOperation::GetProjectInfo);
    match info {
        DevcelResponse::Ok(data) => {
            assert_eq!(data["name"], "Authoring ABI");
            assert_eq!(data["description"], "UTF-8 日本語");
        }
        other => panic!("Shared session lost: {other:?}"),
    }
    for name in [
        "BeginTransaction",
        "SyncProjectState",
        "ValidateDataNameCommand",
    ] {
        assert_eq!(execute_json(json!({"op":name}))["status"], "Error");
    }
    let invalid = CString::new("{\"op\":\"").unwrap();
    unsafe {
        let output = devcel_execute_json(invalid.as_ptr());
        let error: Value = serde_json::from_slice(CStr::from_ptr(output).to_bytes()).unwrap();
        assert_eq!(error["status"], "Error");
        assert_eq!(error["data"]["kind"], "text");
        devcel_free_string(output);
        let mut len = usize::MAX;
        assert!(devcel_execute(std::ptr::null(), 0, &mut len).is_null());
        assert_eq!(len, 0);
    }
    // A typed warning report survives JSON and MessagePack. The acknowledged
    // retry uses the same candidate and read-time revision, never a parsed string.
    let created = execute_json(json!({"op":"CreateTable","data":{
        "parent_path":"", "data_name":"Values", "display_name":"Values"
    }}));
    assert_eq!(created["status"], "Ok", "{created}");
    let table_id = created["data"]["table_uuid"].as_str().unwrap().to_owned();
    assert_eq!(
        execute_json(json!({"op":"AddColumn","data":{
            "table_uuid":table_id,"column_name":"label","column_type":"String"
        }}))["status"],
        "Ok"
    );
    assert_eq!(
        execute_json(json!({"op":"AddRecord","data":{
            "table_uuid":table_id,"record_uuid":"22222222-2222-4222-8222-222222222222"
        }}))["status"],
        "Ok"
    );
    let loaded = execute_json(json!({"op":"GetTableData","data":{"table_uuid":table_id}}));
    assert_eq!(loaded["status"], "Ok");
    let mut table = loaded["data"]["table"].clone();
    let revision = loaded["data"]["revision"].clone();
    table["schema"]["columns"][0]["input_validation"] = json!({
        "mode":"warn","message":"Review this value","hint":"","rules":[{"kind":"required"}]
    });
    table["records"][0]["values"]["label"] = json!("ready");
    // Rule introduction may grandfather existing data. Start with a valid value,
    // then clear it to exercise an actual new input warning.
    let setup = execute_json(json!({"op":"UpdateTableData","data":{
        "table_uuid":table_id,"expected_revision":revision,"data":table,"acknowledgement":null
    }}));
    assert_eq!(setup["status"], "Ok", "{setup}");
    let loaded = execute_json(json!({"op":"GetTableData","data":{"table_uuid":table_id}}));
    assert_eq!(loaded["status"], "Ok");
    let mut table = loaded["data"]["table"].clone();
    table["records"][0]["values"]["label"] = json!("");
    let mut update = json!({"op":"UpdateTableData","data":{
        "table_uuid":table_id,"expected_revision":loaded["data"]["revision"],"data":table,"acknowledgement":null
    }});
    let warning = execute_json(update.clone());
    assert_eq!(warning["status"], "Error", "{warning}");
    assert_eq!(warning["data"]["kind"], "input_validation", "{warning}");
    assert!(!warning["data"]["report"]["issues"]
        .as_array()
        .unwrap()
        .is_empty());
    let packed_warning = execute_messagepack(serde_json::from_value(update.clone()).unwrap());
    assert!(matches!(
        packed_warning,
        DevcelResponse::Error(devcel_core::AppError::InputValidation { .. })
    ));
    update["data"]["acknowledgement"] = warning["data"]["report"]["acknowledgement"].clone();
    assert_eq!(execute_json(update)["status"], "Ok");

    let readers: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(|| {
                assert!(matches!(
                    execute_messagepack(DevcelOperation::GetProjectInfo),
                    DevcelResponse::Ok(_)
                ));
            })
        })
        .collect();
    for reader in readers {
        reader.join().unwrap();
    }
    assert!(matches!(
        execute_messagepack(DevcelOperation::CloseProject),
        DevcelResponse::Ok(_)
    ));
    assert_eq!(
        execute_json(json!({"op":"HasProject"}))["data"]["value"],
        false
    );
    devcel_cleanup();
    assert_eq!(execute_json(json!({"op":"HasProject"}))["status"], "Error");
}
