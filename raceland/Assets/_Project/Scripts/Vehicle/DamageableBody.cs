using System;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Bang Parts damage: the buggy's welded-on scrap panels are separate child objects,
    /// and a hard enough hit tears them off as loose rigidbodies.
    ///
    /// The panels are children of the chassis with no colliders of their own during
    /// normal driving, so they cost nothing until they detach. The chassis keeps one
    /// convex collider throughout — losing panels is cosmetic and never changes the
    /// vehicle's collision shape or mass, which would make crashes feel inconsistent.
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class DamageableBody : MonoBehaviour
    {
        [Serializable]
        public class Panel
        {
            [Tooltip("The panel mesh. Must be a child of the buggy with its own pivot " +
                     "(this is the Bang Parts split from Rodin, kept through Blender).")]
            public Transform target;

            [Tooltip("Collision impulse needed to tear this panel off. Bumpers should be " +
                     "tougher than door panels.")]
            public float detachImpulse = 45f;

            [NonSerialized] public bool Detached;
        }

        [Header("Panels")]
        [SerializeField] private Panel[] panels = Array.Empty<Panel>();

        [Header("Detach behaviour")]
        [Tooltip("Mass given to a detached panel. Light, so debris tumbles rather than " +
                 "shoving the buggy around.")]
        [SerializeField] private float panelMass = 12f;

        [Tooltip("Outward kick applied when a panel tears off, in newton-seconds.")]
        [SerializeField] private float detachImpulseStrength = 4f;

        [Tooltip("Random spin applied on detach, so panels don't all tumble identically.")]
        [SerializeField] private float detachSpin = 6f;

        [Tooltip("Seconds a detached panel lies around before sinking away.")]
        [SerializeField] private float panelLifetime = 6f;

        [Tooltip("Layer for detached debris. Set this to a layer that does NOT collide with " +
                 "the vehicle layer, or torn-off panels will bounce back into the buggy.")]
        [SerializeField] private int debrisLayer;

        [Header("Impact filtering")]
        [Tooltip("At most this many panels come off in a single collision — a head-on wreck " +
                 "shouldn't strip the whole car in one frame.")]
        [SerializeField] private int maxPanelsPerImpact = 2;

        private BuggyController buggy;

        /// <summary>Raised for each panel that tears off, with the panel's world position.</summary>
        public event Action<Vector3> PanelDetached;

        /// <summary>How many panels are still attached. Drives nothing yet; useful for a damage HUD.</summary>
        public int PanelsRemaining { get; private set; }

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            PanelsRemaining = panels.Length;
        }

        private void OnEnable()
        {
            if (buggy != null) buggy.Impact += HandleImpact;
        }

        private void OnDisable()
        {
            if (buggy != null) buggy.Impact -= HandleImpact;
        }

        private void HandleImpact(Vector3 point, float impulse)
        {
            int detachedThisImpact = 0;

            foreach (Panel panel in panels)
            {
                if (detachedThisImpact >= maxPanelsPerImpact) break;
                if (panel.Detached || panel.target == null) continue;
                if (impulse < panel.detachImpulse) continue;

                // Only tear off panels near the impact — a rear-end hit shouldn't drop the
                // bonnet. The tolerance is generous because the buggy is small.
                if (Vector3.Distance(panel.target.position, point) > 2.5f) continue;

                Detach(panel, point);
                detachedThisImpact++;
            }
        }

        private void Detach(Panel panel, Vector3 impactPoint)
        {
            panel.Detached = true;
            PanelsRemaining--;

            Transform piece = panel.target;
            Vector3 inheritedVelocity = buggy != null
                ? buggy.Body.GetPointVelocity(piece.position)
                : Vector3.zero;

            piece.SetParent(null, true);
            piece.gameObject.layer = debrisLayer;

            if (!piece.TryGetComponent(out Collider _))
            {
                // Rodin/Blender panels arrive as bare meshes. A box around the renderer
                // bounds is plenty for debris and far cheaper than a mesh collider.
                var box = piece.gameObject.AddComponent<BoxCollider>();
                if (piece.TryGetComponent(out Renderer renderer))
                {
                    box.center = piece.InverseTransformPoint(renderer.bounds.center);
                    box.size = piece.InverseTransformVector(renderer.bounds.size);
                    box.size = new Vector3(
                        Mathf.Abs(box.size.x), Mathf.Abs(box.size.y), Mathf.Abs(box.size.z));
                }
            }

            var body = piece.gameObject.AddComponent<Rigidbody>();
            body.mass = panelMass;
            body.velocity = inheritedVelocity;
            body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

            Vector3 away = (piece.position - impactPoint).normalized;
            if (away.sqrMagnitude < 0.01f) away = Vector3.up;

            body.AddForce(away * detachImpulseStrength, ForceMode.Impulse);
            body.AddTorque(UnityEngine.Random.insideUnitSphere * detachSpin, ForceMode.Impulse);

            var lifetimeController = piece.gameObject.AddComponent<DetachedPart>();
            lifetimeController.Begin(panelLifetime, 1.5f);

            PanelDetached?.Invoke(piece.position);
        }

        /// <summary>
        /// Reattaching torn-off panels is not possible once they've been destroyed, so a
        /// respawn that should restore the buggy's bodywork must reload the vehicle prefab.
        /// The race manager does this on a full restart; a checkpoint respawn deliberately
        /// keeps the damage, because carrying your dents is half the fun.
        /// </summary>
        public bool AnyPanelsDetached => PanelsRemaining < panels.Length;
    }
}
