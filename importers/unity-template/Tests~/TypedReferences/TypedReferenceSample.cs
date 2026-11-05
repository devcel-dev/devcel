using System.Collections.Generic;
using UnityEngine;
using Game.Master;
public sealed class TypedReferenceSample : MonoBehaviour
{
    public EnemiesReference enemy = EnemiesReferences.Slime.ToReference();
    public IDamageableReference target = EnemiesReferences.Slime.AsDamageable().ToReference();
    public EnemiesReference[] enemies = { EnemiesReferences.Slime.ToReference(), new EnemiesReference() };
    public List<IDamageableReference> targets = new List<IDamageableReference> { PropsReferences.Barrel.AsDamageable().ToReference() };
}
