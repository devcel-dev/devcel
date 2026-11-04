using System;
using UnityEngine;

namespace Devcel.Unity
{
    /// <summary>Serialized ID only. Generated subclasses resolve against an explicit typed database.</summary>
    [Serializable]
    public abstract class DevcelTypedRecordReference
    {
        [SerializeField] private string uuid = string.Empty;
        public string Uuid => uuid;
        public bool IsEmpty => string.IsNullOrEmpty(uuid);
        protected DevcelTypedRecordReference(string uuid) { this.uuid = uuid ?? string.Empty; }
    }

    [AttributeUsage(AttributeTargets.Class, Inherited = false)]
    public sealed class DevcelRecordTargetAttribute : Attribute
    {
        public Type DatabaseType { get; }
        public string TableName { get; }
        public string TableUuid { get; }
        public DevcelRecordTargetAttribute(Type databaseType, string tableName, string tableUuid)
        { DatabaseType = databaseType; TableName = tableName; TableUuid = tableUuid; }
    }

    // Emitted only under UNITY_EDITOR: authoring labels do not bloat runtime rows/bundles.
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
    public sealed class DevcelRecordLabelAttribute : Attribute
    {
        public string Uuid { get; }
        public string Label { get; }
        public DevcelRecordLabelAttribute(string uuid, string label) { Uuid = uuid; Label = label; }
    }

    [Serializable]
    public abstract class DevcelTypedInterfaceReference : DevcelTypedRecordReference
    {
        [SerializeField] private string tableUuid = string.Empty;
        public string TableUuid => tableUuid;
        protected DevcelTypedInterfaceReference(string tableUuid, string uuid) : base(uuid)
        { this.tableUuid = tableUuid ?? string.Empty; }
    }

    [AttributeUsage(AttributeTargets.Class, Inherited = false)]
    public sealed class DevcelInterfaceTargetAttribute : Attribute
    {
        public Type DatabaseType { get; }
        public string InterfaceUuid { get; }
        public DevcelInterfaceTargetAttribute(Type databaseType, string interfaceUuid)
        { DatabaseType = databaseType; InterfaceUuid = interfaceUuid; }
    }

    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
    public sealed class DevcelImplementingTableAttribute : Attribute
    {
        public Type ReferenceType { get; }
        public string TableUuid { get; }
        public string TableName { get; }
        public DevcelImplementingTableAttribute(Type referenceType, string tableUuid, string tableName)
        { ReferenceType = referenceType; TableUuid = tableUuid; TableName = tableName; }
    }
}
