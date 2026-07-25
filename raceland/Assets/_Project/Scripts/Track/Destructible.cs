using System;
using Raceland.Vehicle;
using UnityEngine;

namespace Raceland.Track
{
    /// <summary>
    /// A wasteland obstacle — burnt-out wreck, tyre stack, concrete block — that breaks
    /// into two pieces when hit hard enough.
    ///
    /// The two halves are pre-authored children (the Bang Parts split from Rodin, kept
    /// through Blender) that stay disabled and collider-less until the moment of impact.
    /// Swapping intact-for-broken is far cheaper than runtime mesh slicing and gives
    /// art control over how the break reads.
    /// </summary>
    public class Destructible : MonoBehaviour
    {
        [Header("Pieces")]
        [Tooltip("The intact object: mesh plus collider. Disabled when it shatters.")]
        [SerializeField] private GameObject intact;

        [Tooltip("The two halves. Kept disabled until impact, then released as rigidbodies.")]
        [SerializeField] private GameObject[] halves = new GameObject[2];

        [Header("Break threshold")]
        [Tooltip("Collision impulse needed to break this. Tyre stacks should be low, " +
                 "concrete blocks high.")]
        [SerializeField] private float breakImpulse = 25f;

        [Tooltip("Only the player breaks obstacles. Stops debris from one wreck chain-" +
                 "reacting through the whole scene and tanking the frame rate.")]
        [SerializeField] private bool playerOnly = true;

        [Header("Break forces")]
        [SerializeField] private float halfMass = 30f;

        [Tooltip("How hard the halves are pushed apart, in newton-seconds.")]
        [SerializeField] private float separationImpulse = 5f;

        [Tooltip("How much of the impact direction the halves inherit.")]
        [SerializeField] private float impactTransferScale = 0.35f;

        [SerializeField] private float halfSpin = 4f;

        [Header("Cleanup")]
        [Tooltip("Seconds a half lies around before sinking away. Keep this short — " +
                 "obstacle debris is the main source of stray rigidbodies on a long run.")]
        [SerializeField] private float halfLifetime = 4f;

        [SerializeField] private int debrisLayer;

        [Header("Feedback")]
        [SerializeField] private AudioClip breakSound;
        [SerializeField] private ParticleSystem breakEffect;

        private bool shattered;

        /// <summary>
        /// Raised whenever any obstacle in the scene breaks, with the world position and
        /// the impulse that did it. The stunt scorer listens to this rather than every
        /// obstacle individually, since obstacles are created and destroyed at runtime.
        /// </summary>
        public static event Action<Vector3, float> AnyShattered;

        private void OnCollisionEnter(Collision collision)
        {
            if (shattered) return;

            float impulse = collision.impulse.magnitude;
            if (impulse < breakImpulse) return;

            if (playerOnly)
            {
                Rigidbody other = collision.rigidbody;
                if (other == null || !other.CompareTag("Player")) return;
            }

            Vector3 point = collision.contactCount > 0
                ? collision.GetContact(0).point
                : transform.position;

            Shatter(point, collision.relativeVelocity, impulse);
        }

        /// <summary>Break the obstacle. Public so a scripted event can trigger it too.</summary>
        public void Shatter(Vector3 impactPoint, Vector3 impactVelocity, float impulse)
        {
            if (shattered) return;
            shattered = true;

            if (intact != null) intact.SetActive(false);

            foreach (GameObject half in halves)
            {
                if (half == null) continue;
                ReleaseHalf(half, impactPoint, impactVelocity);
            }

            if (breakEffect != null)
            {
                breakEffect.transform.SetParent(null, true);
                breakEffect.Play();
                Destroy(breakEffect.gameObject, 3f);
            }

            if (breakSound != null)
            {
                AudioSource.PlayClipAtPoint(breakSound, impactPoint, 0.9f);
            }

            AnyShattered?.Invoke(transform.position, impulse);

            // The root is now an empty shell — the halves have reparented out of it.
            // Give the particle system a moment before tearing it down.
            Destroy(gameObject, 0.1f);
        }

        private void ReleaseHalf(GameObject half, Vector3 impactPoint, Vector3 impactVelocity)
        {
            half.SetActive(true);
            half.transform.SetParent(null, true);
            half.layer = debrisLayer;

            if (!half.TryGetComponent(out Collider _))
            {
                var box = half.AddComponent<BoxCollider>();
                if (half.TryGetComponent(out Renderer renderer))
                {
                    box.center = half.transform.InverseTransformPoint(renderer.bounds.center);
                    Vector3 size = half.transform.InverseTransformVector(renderer.bounds.size);
                    box.size = new Vector3(Mathf.Abs(size.x), Mathf.Abs(size.y), Mathf.Abs(size.z));
                }
            }

            var body = half.AddComponent<Rigidbody>();
            body.mass = halfMass;

            // Inherit part of the hit, then push the halves apart from each other so the
            // break reads as two pieces rather than one object that suddenly has a seam.
            body.velocity = -impactVelocity * impactTransferScale;

            Vector3 away = half.transform.position - impactPoint;

            // Qualified: this file also has `using System`, which makes a bare `Random`
            // ambiguous between System.Random and UnityEngine.Random.
            if (away.sqrMagnitude < 0.01f) away = UnityEngine.Random.onUnitSphere;
            away.y = Mathf.Abs(away.y) + 0.3f;

            body.AddForce(away.normalized * separationImpulse, ForceMode.Impulse);
            body.AddTorque(UnityEngine.Random.insideUnitSphere * halfSpin, ForceMode.Impulse);

            half.AddComponent<DetachedPart>().Begin(halfLifetime, 1.2f);
        }
    }
}
