using System;
using UnityEngine;

namespace Devcel.Unity
{
    /// <summary>
    /// A serialized, project-scoped record ID. Resolve with the generated table's ById(Uuid).
    /// It owns no database or native handle and never writes to the authoring project.
    /// </summary>
    [Serializable]
    public sealed class DevcelRecordReference
    {
        [SerializeField] private string projectName = string.Empty;
        [SerializeField] private string tableName = string.Empty;
        [SerializeField] private string uuid = string.Empty;
        public string ProjectName => projectName;
        public string TableName => tableName;
        public string Uuid => uuid;
        public bool IsEmpty => string.IsNullOrEmpty(uuid);
        public DevcelRecordReference() { }
        public DevcelRecordReference(string projectName, string tableName, string uuid)
        { this.projectName = projectName ?? string.Empty; this.tableName = tableName ?? string.Empty; this.uuid = uuid ?? string.Empty; }
        public override string ToString() => IsEmpty ? "(None)" : $"{ProjectName}/{TableName}/{Uuid}";
    }
}
