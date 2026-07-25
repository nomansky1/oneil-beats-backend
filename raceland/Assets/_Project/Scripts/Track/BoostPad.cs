using Raceland.Vehicle;
using UnityEngine;

namespace Raceland.Track
{
    /// <summary>
    /// Welded scrap ramp with a glowing strip: drive over it, get shoved forward.
    ///
    /// The pad hands off to <c>BoostSystem</c> rather than pushing the rigidbody itself,
    /// so pad boost and button boost share one force path and one set of audio/FOV cues.
    /// </summary>
    [RequireComponent(typeof(Collider))]
    public class BoostPad : MonoBehaviour
    {
        [Tooltip("Seconds before the same pad can fire again. Stops a buggy that lands " +
                 "on the pad and bounces from triggering it several times.")]
        [SerializeField] private float retriggerDelay = 0.75f;

        [Tooltip("Optional emissive strip pulsed when the pad fires.")]
        [SerializeField] private Renderer glowStrip;

        [SerializeField] private Color idleColour = new Color(1f, 0.55f, 0.1f);
        [SerializeField] private Color firedColour = new Color(1f, 0.95f, 0.6f);

        [Tooltip("Seconds the strip stays lit after firing.")]
        [SerializeField] private float flashDuration = 0.35f;

        [SerializeField] private AudioClip fireSound;

        private float lastFireTime = -99f;
        private MaterialPropertyBlock propertyBlock;

        private static readonly int BaseColourId = Shader.PropertyToID("_BaseColor");
        private static readonly int EmissionColourId = Shader.PropertyToID("_EmissionColor");

        private void Reset() => GetComponent<Collider>().isTrigger = true;

        private void Awake()
        {
            GetComponent<Collider>().isTrigger = true;
            propertyBlock = new MaterialPropertyBlock();
            ApplyGlow(idleColour);
        }

        private void OnTriggerEnter(Collider other)
        {
            if (Time.time - lastFireTime < retriggerDelay) return;

            Rigidbody attached = other.attachedRigidbody;
            if (attached == null) return;

            BoostSystem boost = attached.GetComponent<BoostSystem>();
            if (boost == null) return;

            lastFireTime = Time.time;
            boost.TriggerPadBoost();

            ApplyGlow(firedColour);
            CancelInvoke(nameof(ResetGlow));
            Invoke(nameof(ResetGlow), flashDuration);

            if (fireSound != null)
            {
                AudioSource.PlayClipAtPoint(fireSound, transform.position, 0.8f);
            }
        }

        private void ResetGlow() => ApplyGlow(idleColour);

        private void ApplyGlow(Color colour)
        {
            if (glowStrip == null) return;

            glowStrip.GetPropertyBlock(propertyBlock);
            propertyBlock.SetColor(BaseColourId, colour);
            propertyBlock.SetColor(EmissionColourId, colour * 2f);
            glowStrip.SetPropertyBlock(propertyBlock);
        }
    }
}
