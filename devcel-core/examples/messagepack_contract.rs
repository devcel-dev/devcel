//! Serialize the current canonical operations and P2P request envelopes.
use devcel_core::operations::{DevcelOperation, DevcelResponse};

fn main() {
    let operations = [
        DevcelOperation::GetProjectInfo,
        DevcelOperation::CreateTable {
            parent_path: String::new(),
            data_name: "items".into(),
            display_name: "Items".into(),
        },
    ];
    for operation in operations {
        let json = serde_json::to_string(&operation).unwrap();
        let bytes = rmp_serde::to_vec_named(&operation).unwrap();
        let decoded: DevcelOperation = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded, operation);
        println!(
            "Canonical operation: {json}; MessagePack bytes: {}",
            bytes.len()
        );
        #[cfg(feature = "p2p")]
        {
            use devcel_core::p2p_messages::P2PMessage;
            let request = P2PMessage::request(1, operation);
            let bytes = rmp_serde::to_vec_named(&request).unwrap();
            assert!(matches!(
                rmp_serde::from_slice::<P2PMessage>(&bytes).unwrap(),
                P2PMessage::Request { id: 1, .. }
            ));
            println!("Request envelope bytes: {}", bytes.len());
        }
    }
    let response = DevcelResponse::Ok(serde_json::json!({"value":true}));
    let bytes = rmp_serde::to_vec_named(&response).unwrap();
    assert!(matches!(
        rmp_serde::from_slice::<DevcelResponse>(&bytes).unwrap(),
        DevcelResponse::Ok(_)
    ));
}
