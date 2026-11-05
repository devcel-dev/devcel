using UnityEngine;
using Game.Master;
public sealed class TypedReferenceAsset : ScriptableObject
{
    public EnemiesReference enemy = new EnemiesReference();
    public IDamageableReference target = new IDamageableReference();
    public EnemiesReference[] enemies = { new EnemiesReference(), new EnemiesReference() };
}
