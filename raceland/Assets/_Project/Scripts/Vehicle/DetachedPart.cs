using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Lifetime manager for a piece of debris — a torn-off body panel or half a shattered
    /// obstacle. Sinks the piece into the ground and destroys it so a long session doesn't
    /// accumulate hundreds of rigidbodies.
    ///
    /// Sinking rather than fading avoids needing a transparent material variant of every
    /// wasteland material, which would cost us draw calls and break batching.
    /// </summary>
    public class DetachedPart : MonoBehaviour
    {
        [Tooltip("Seconds the piece lies around before it starts sinking.")]
        [SerializeField] private float lifetime = 5f;

        [Tooltip("Seconds spent sinking out of sight before the object is destroyed.")]
        [SerializeField] private float sinkDuration = 1.5f;

        [Tooltip("How far the piece sinks. Should exceed the piece's own height.")]
        [SerializeField] private float sinkDistance = 2f;

        private float timer;
        private bool sinking;
        private Vector3 sinkStart;

        /// <summary>
        /// Configure and start the countdown. Called by whichever system spawned the piece
        /// so the timings can be tuned per source (panels linger longer than obstacle halves).
        /// </summary>
        public void Begin(float lifetimeSeconds, float sinkSeconds)
        {
            lifetime = lifetimeSeconds;
            sinkDuration = sinkSeconds;
            timer = 0f;
            sinking = false;
        }

        private void Update()
        {
            timer += Time.deltaTime;

            if (!sinking)
            {
                if (timer < lifetime) return;

                sinking = true;
                timer = 0f;
                sinkStart = transform.position;

                // Stop simulating: a sinking rigidbody would push itself back out of the
                // ground as soon as it intersects the collider.
                if (TryGetComponent(out Rigidbody body))
                {
                    body.isKinematic = true;
                }

                foreach (var collider in GetComponentsInChildren<Collider>())
                {
                    collider.enabled = false;
                }

                return;
            }

            float t = sinkDuration <= 0f ? 1f : Mathf.Clamp01(timer / sinkDuration);
            transform.position = sinkStart + Vector3.down * (sinkDistance * t);

            if (t >= 1f) Destroy(gameObject);
        }
    }
}
