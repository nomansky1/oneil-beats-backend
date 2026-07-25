using Raceland.Vehicle;
using UnityEngine;

namespace Raceland.CameraRig
{
    /// <summary>
    /// Smoothed chase camera with speed-driven FOV and impact shake.
    ///
    /// Deliberately hand-rolled rather than Cinemachine: the behaviours the brief asks
    /// for are a handful of lerps, and skipping the dependency keeps the build small and
    /// the tuning knobs in one inspector.
    ///
    /// Runs in LateUpdate so it reads the buggy's final interpolated transform for the
    /// frame; following in Update would trail one frame behind and feel spongy.
    /// </summary>
    public class ChaseCamera : MonoBehaviour
    {
        [Header("Target")]
        [Tooltip("The buggy to follow. Left empty, the camera finds the BuggyController in " +
                 "the scene at startup.")]
        [SerializeField] private BuggyController target;

        [Header("Framing")]
        [Tooltip("Camera offset behind and above the buggy, in the buggy's local space.")]
        [SerializeField] private Vector3 followOffset = new Vector3(0f, 2.6f, -6.5f);

        [Tooltip("How far ahead of the buggy the camera aims, scaled by speed. Look-ahead is " +
                 "what makes fast sections readable.")]
        [SerializeField] private float lookAheadAtTopSpeed = 8f;

        [Tooltip("Height above the buggy's origin that the camera aims at.")]
        [SerializeField] private float lookAtHeight = 1.1f;

        [Header("Smoothing")]
        [Tooltip("Position follow speed. Higher is tighter and more responsive.")]
        [SerializeField] private float positionSmoothing = 6f;

        [Tooltip("Rotation follow speed.")]
        [SerializeField] private float rotationSmoothing = 8f;

        [Tooltip("Extra distance added at top speed, so the buggy pulls away from the camera " +
                 "as it accelerates.")]
        [SerializeField] private float speedPullback = 2f;

        [Header("Field of view")]
        [SerializeField] private float baseFov = 62f;

        [Tooltip("FOV at top speed. The widening is most of the sense of speed.")]
        [SerializeField] private float topSpeedFov = 78f;

        [Tooltip("Additional FOV punch while boosting.")]
        [SerializeField] private float boostFovPunch = 8f;

        [Tooltip("How fast the FOV chases its target.")]
        [SerializeField] private float fovSmoothing = 4f;

        [Header("Shake")]
        [Tooltip("Collision impulse that produces a full-strength shake.")]
        [SerializeField] private float impulseForMaxShake = 120f;

        [Tooltip("Maximum positional shake, in metres.")]
        [SerializeField] private float maxShakeAmplitude = 0.45f;

        [Tooltip("How quickly a shake decays away.")]
        [SerializeField] private float shakeDecay = 3.5f;

        [Tooltip("Shake wobble frequency.")]
        [SerializeField] private float shakeFrequency = 22f;

        [Header("Recovery")]
        [Tooltip("When the buggy is upside down its local offset would put the camera under " +
                 "the track. Above this much tilt the camera falls back to a world-up frame " +
                 "so the player never loses their bearings mid-roll.")]
        [Range(0f, 1f)]
        [SerializeField] private float uprightBlendThreshold = 0.35f;

        private UnityEngine.Camera cam;
        private BoostSystem boost;
        private float shakeStrength;
        private float shakeSeed;

        private void Awake()
        {
            cam = GetComponent<UnityEngine.Camera>();
            if (cam == null) cam = GetComponentInChildren<UnityEngine.Camera>();

            shakeSeed = Random.value * 100f;

            if (target == null) target = FindObjectOfType<BuggyController>();
            Bind(target);
        }

        /// <summary>
        /// Point the camera at a buggy. Called on startup and again if the vehicle is
        /// respawned as a fresh instance (a full restart reloads the prefab to restore
        /// torn-off panels, which invalidates the old reference).
        /// </summary>
        public void Bind(BuggyController buggy)
        {
            Unsubscribe();

            target = buggy;
            boost = target != null ? target.GetComponent<BoostSystem>() : null;

            Subscribe();

            if (target != null) SnapToTarget();
        }

        // Subscription lives entirely in Bind/Subscribe rather than being split with
        // OnEnable, so re-binding to a fresh buggy after a restart can't leave a
        // dangling handler on the destroyed one — or double-subscribe to the new one.
        private void Subscribe()
        {
            if (target != null) target.Impact += HandleImpact;
            if (boost != null) boost.BoostStarted += HandleBoostStarted;
        }

        private void Unsubscribe()
        {
            if (target != null) target.Impact -= HandleImpact;
            if (boost != null) boost.BoostStarted -= HandleBoostStarted;
        }

        private void OnDestroy() => Unsubscribe();

        /// <summary>Jump straight to the ideal pose with no smoothing — used after a respawn.</summary>
        public void SnapToTarget()
        {
            if (target == null) return;

            GetDesiredPose(out Vector3 position, out Quaternion rotation);
            transform.SetPositionAndRotation(position, rotation);
        }

        private void LateUpdate()
        {
            if (target == null) return;

            GetDesiredPose(out Vector3 desiredPosition, out Quaternion desiredRotation);

            float positionBlend = 1f - Mathf.Exp(-positionSmoothing * Time.deltaTime);
            float rotationBlend = 1f - Mathf.Exp(-rotationSmoothing * Time.deltaTime);

            Vector3 position = Vector3.Lerp(transform.position, desiredPosition, positionBlend);
            Quaternion rotation = Quaternion.Slerp(transform.rotation, desiredRotation, rotationBlend);

            transform.SetPositionAndRotation(position + CurrentShakeOffset(), rotation);

            UpdateFieldOfView();
            DecayShake();
        }

        private void GetDesiredPose(out Vector3 position, out Quaternion rotation)
        {
            Transform t = target.transform;
            float speed = target.NormalizedSpeed;

            // Blend the camera's reference frame towards world-up as the buggy tips over,
            // so a roll spins the car on screen rather than spinning the world.
            float upright = Mathf.Clamp01(Vector3.Dot(t.up, Vector3.up));
            float worldBlend = Mathf.InverseLerp(uprightBlendThreshold, 1f, upright);

            Vector3 flatForward = Vector3.ProjectOnPlane(t.forward, Vector3.up);
            if (flatForward.sqrMagnitude < 0.001f) flatForward = Vector3.forward;
            flatForward.Normalize();

            Quaternion localFrame = t.rotation;
            Quaternion worldFrame = Quaternion.LookRotation(flatForward, Vector3.up);
            Quaternion frame = Quaternion.Slerp(worldFrame, localFrame, worldBlend);

            Vector3 offset = followOffset;
            offset.z -= speedPullback * speed;

            position = t.position + frame * offset;

            Vector3 lookTarget = t.position
                                 + Vector3.up * lookAtHeight
                                 + flatForward * (lookAheadAtTopSpeed * speed);

            Vector3 toTarget = lookTarget - position;
            if (toTarget.sqrMagnitude < 0.001f) toTarget = flatForward;

            rotation = Quaternion.LookRotation(toTarget.normalized, Vector3.up);
        }

        private void UpdateFieldOfView()
        {
            if (cam == null) return;

            float targetFov = Mathf.Lerp(baseFov, topSpeedFov, target.NormalizedSpeed);
            if (boost != null && boost.IsBoosting) targetFov += boostFovPunch;

            float blend = 1f - Mathf.Exp(-fovSmoothing * Time.deltaTime);
            cam.fieldOfView = Mathf.Lerp(cam.fieldOfView, targetFov, blend);
        }

        private Vector3 CurrentShakeOffset()
        {
            if (shakeStrength <= 0.001f) return Vector3.zero;

            float time = Time.time * shakeFrequency;

            // Perlin rather than Random so the shake is a smooth wobble instead of noise.
            float x = (Mathf.PerlinNoise(shakeSeed, time) - 0.5f) * 2f;
            float y = (Mathf.PerlinNoise(shakeSeed + 17f, time) - 0.5f) * 2f;
            float z = (Mathf.PerlinNoise(shakeSeed + 43f, time) - 0.5f) * 2f;

            return new Vector3(x, y, z) * (shakeStrength * maxShakeAmplitude);
        }

        private void DecayShake()
        {
            if (shakeStrength <= 0f) return;
            shakeStrength = Mathf.Max(0f, shakeStrength - shakeDecay * Time.deltaTime);
        }

        private void HandleImpact(Vector3 point, float impulse)
        {
            AddShake(Mathf.Clamp01(impulse / impulseForMaxShake));
        }

        private void HandleBoostStarted()
        {
            AddShake(0.2f);
        }

        /// <summary>Kick the camera. 0..1; the strongest request wins rather than stacking.</summary>
        public void AddShake(float strength01)
        {
            shakeStrength = Mathf.Max(shakeStrength, Mathf.Clamp01(strength01));
        }
    }
}
