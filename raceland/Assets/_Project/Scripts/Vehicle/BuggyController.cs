using System;
using Raceland.Core;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Arcade physics for the wasteland buggy: raycast suspension, tyre grip modelled
    /// as a lateral velocity-cancelling force, a speed-dependent power curve, and
    /// in-air rotation control for stunts.
    ///
    /// Tuning philosophy (per the brief): springy and satisfying, not realistic. The
    /// buggy should corner hard without tipping on flat ground, but still roll if you
    /// land badly off a kicker.
    /// </summary>
    [RequireComponent(typeof(Rigidbody))]
    public class BuggyController : MonoBehaviour
    {
        [Header("Wheels")]
        [Tooltip("Four corners, in any order. Front wheels should have 'steers' ticked.")]
        [SerializeField] private Wheel[] wheels = new Wheel[4];

        [Tooltip("What the suspension casts against. Exclude the vehicle's own layer.")]
        [SerializeField] private LayerMask groundMask = ~0;

        [Header("Suspension")]
        [Tooltip("Ride height: distance from the anchor to the wheel centre at rest.")]
        [SerializeField] private float suspensionRestLength = 0.55f;

        [Tooltip("How far the spring may extend past rest before the wheel leaves the ground.")]
        [SerializeField] private float suspensionMaxTravel = 0.35f;

        [Tooltip("Spring stiffness. Higher = stiffer, less body roll, more skittish over bumps.")]
        [SerializeField] private float springStrength = 42000f;

        [Tooltip("Spring damping. Too low and the buggy pogos; too high and it feels dead.")]
        [SerializeField] private float springDamper = 3800f;

        [Header("Drive")]
        [Tooltip("Peak drive force per powered wheel, in newtons.")]
        [SerializeField] private float motorForce = 5200f;

        [Tooltip("Force available vs normalised speed (x: speed/topSpeed, y: 0..1 of motorForce). " +
                 "Falling off towards 1 gives a natural top speed without a hard clamp.")]
        [SerializeField]
        private AnimationCurve powerCurve = new AnimationCurve(
            new Keyframe(0f, 1f),
            new Keyframe(0.55f, 0.85f),
            new Keyframe(1f, 0f));

        [Tooltip("Top speed in m/s under engine power alone. 33 m/s is about 120 km/h.")]
        [SerializeField] private float topSpeed = 33f;

        [Tooltip("Reverse is deliberately weak — it's for getting unstuck, not for racing.")]
        [Range(0f, 1f)]
        [SerializeField] private float reverseForceScale = 0.35f;

        [Tooltip("Braking force per grounded wheel.")]
        [SerializeField] private float brakeForce = 6000f;

        [Tooltip("Drag applied along the wheel's rolling axis when coasting.")]
        [SerializeField] private float rollingResistance = 320f;

        [Header("Steering")]
        [Tooltip("Steering lock at a standstill, in degrees.")]
        [SerializeField] private float maxSteerAngle = 32f;

        [Tooltip("Steering lock at top speed. Lower than the standstill value so the buggy " +
                 "doesn't spin out on a straight at speed.")]
        [SerializeField] private float minSteerAngle = 12f;

        [Tooltip("How fast the steering angle chases the input. Lower = heavier, floatier.")]
        [SerializeField] private float steerResponse = 8f;

        [Header("Grip")]
        [Tooltip("Sideways grip vs normalised speed. Dropping off at high speed lets the back " +
                 "step out into a slide instead of gripping like a slot car.")]
        [SerializeField]
        private AnimationCurve gripCurve = new AnimationCurve(
            new Keyframe(0f, 1f),
            new Keyframe(0.5f, 0.8f),
            new Keyframe(1f, 0.55f));

        [Tooltip("Effective mass of one tyre contact patch. Scales how hard grip fights a slide.")]
        [SerializeField] private float tyreMass = 90f;

        [Tooltip("Grip multiplier while the brake is held — drops the rear into a drift.")]
        [Range(0.05f, 1f)]
        [SerializeField] private float handbrakeGripScale = 0.35f;

        [Header("Stability")]
        [Tooltip("Centre of mass offset from the rigidbody origin, in local space. Pulling it " +
                 "down and slightly back is what stops the buggy rolling in every corner.")]
        [SerializeField] private Vector3 centreOfMassOffset = new Vector3(0f, -0.55f, -0.1f);

        [Tooltip("Downforce at top speed, in newtons. Keeps the buggy planted on fast sections.")]
        [SerializeField] private float downforceAtTopSpeed = 5500f;

        [Tooltip("Anti-roll stiffness. Transfers load across each axle to flatten body roll.")]
        [SerializeField] private float antiRollStrength = 9000f;

        [Header("Air control")]
        [Tooltip("Pitch torque from the throttle axis while airborne (for front/back flips).")]
        [SerializeField] private float airPitchTorque = 9000f;

        [Tooltip("Roll torque from the steer axis while airborne (for barrel rolls).")]
        [SerializeField] private float airRollTorque = 7000f;

        [Tooltip("Yaw torque from the steer axis while airborne — lets the player line up a landing.")]
        [SerializeField] private float airYawTorque = 3500f;

        [Header("Impacts")]
        [Tooltip("Collision impulse below this is ignored entirely — stops kerb scrapes " +
                 "triggering camera shake and crash audio.")]
        [SerializeField] private float impactImpulseThreshold = 6f;

        private Rigidbody body;
        private VehicleInputState input;
        private float currentSteerAngle;
        private float boostForce;

        /// <summary>Signed forward speed in metres per second. Negative when reversing.</summary>
        public float ForwardSpeed { get; private set; }

        /// <summary>Absolute speed in km/h, for the HUD.</summary>
        public float SpeedKph => Mathf.Abs(ForwardSpeed) * 3.6f;

        /// <summary>Absolute forward speed as a 0..1 fraction of <see cref="topSpeed"/>.</summary>
        public float NormalizedSpeed => Mathf.Clamp01(Mathf.Abs(ForwardSpeed) / topSpeed);

        /// <summary>How many of the four wheels are touching the ground this step.</summary>
        public int GroundedWheelCount { get; private set; }

        public bool IsGrounded => GroundedWheelCount > 0;

        /// <summary>True when every wheel is off the ground — used by the stunt scorer.</summary>
        public bool IsAirborne => GroundedWheelCount == 0;

        public Rigidbody Body => body;

        /// <summary>Raised on a collision harder than <see cref="impactImpulseThreshold"/>.</summary>
        public event Action<Vector3, float> Impact;

        /// <summary>Raised the physics step the buggy regains ground after being fully airborne.</summary>
        public event Action<float> Landed;

        private void Awake()
        {
            body = GetComponent<Rigidbody>();
            body.centerOfMass = centreOfMassOffset;
            body.interpolation = RigidbodyInterpolation.Interpolate;

            // The buggy is small and fast; discrete collision lets it tunnel through
            // barriers at boost speed.
            body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

            foreach (var wheel in wheels)
            {
                wheel?.Initialise(suspensionRestLength);
            }
        }

        private void FixedUpdate()
        {
            input = VehicleInputHub.Instance != null ? VehicleInputHub.Instance.Current : default;

            ForwardSpeed = Vector3.Dot(body.velocity, transform.forward);

            UpdateSteerAngle(Time.fixedDeltaTime);

            bool wasAirborne = IsAirborne;
            GroundedWheelCount = 0;

            foreach (var wheel in wheels)
            {
                if (wheel?.anchor == null) continue;
                UpdateWheel(wheel, Time.fixedDeltaTime);
                if (wheel.IsGrounded) GroundedWheelCount++;
            }

            ApplyAntiRoll();
            ApplyDownforce();

            if (IsAirborne) ApplyAirControl();
            else if (wasAirborne) Landed?.Invoke(Mathf.Abs(Vector3.Dot(body.velocity, transform.up)));

            ApplyBoost();
        }

        private void UpdateSteerAngle(float dt)
        {
            // Steering lock tightens with speed so the buggy stays controllable flat out.
            float lockAtSpeed = Mathf.Lerp(maxSteerAngle, minSteerAngle, NormalizedSpeed);
            float target = input.Steer * lockAtSpeed;
            currentSteerAngle = Mathf.Lerp(currentSteerAngle, target, 1f - Mathf.Exp(-steerResponse * dt));
        }

        private void UpdateWheel(Wheel wheel, float dt)
        {
            float castLength = suspensionRestLength + suspensionMaxTravel + wheel.radius;
            Vector3 origin = wheel.anchor.position;
            Vector3 down = -wheel.anchor.up;

            wheel.SteerAngle = wheel.steers ? currentSteerAngle : 0f;

            if (!Physics.Raycast(origin, down, out RaycastHit hit, castLength, groundMask,
                    QueryTriggerInteraction.Ignore))
            {
                wheel.IsGrounded = false;
                wheel.CompressionRatio = 0f;
                wheel.CurrentLength = suspensionRestLength + suspensionMaxTravel;
                wheel.PreviousLength = wheel.CurrentLength;
                SpinFreeWheel(wheel, dt);
                return;
            }

            wheel.IsGrounded = true;
            wheel.ContactPoint = hit.point;
            wheel.ContactNormal = hit.normal;

            float currentLength = Mathf.Max(0f, hit.distance - wheel.radius);
            wheel.CurrentLength = currentLength;
            wheel.CompressionRatio = Mathf.Clamp01(
                (suspensionRestLength - currentLength) / suspensionRestLength);

            ApplySuspension(wheel, currentLength, dt);
            ApplyGrip(wheel, dt);
            ApplyDrive(wheel);

            wheel.PreviousLength = currentLength;
            SpinGroundedWheel(wheel, dt);
        }

        private void ApplySuspension(Wheel wheel, float currentLength, float dt)
        {
            Vector3 springDirection = wheel.anchor.up;

            float offset = suspensionRestLength - currentLength;
            float springVelocity = (wheel.PreviousLength - currentLength) / dt;

            float force = (offset * springStrength) + (springVelocity * springDamper);

            // A spring may push but never pull — without this the buggy gets sucked
            // onto the ground when the suspension is extended past rest.
            if (force < 0f) force = 0f;

            body.AddForceAtPosition(springDirection * force, wheel.anchor.position);
        }

        private void ApplyGrip(Wheel wheel, float dt)
        {
            Vector3 steerRotation = Quaternion.AngleAxis(wheel.SteerAngle, transform.up) * transform.right;

            // Project onto the contact plane so grip doesn't fight the suspension on a slope.
            Vector3 lateralAxis = Vector3.ProjectOnPlane(steerRotation, wheel.ContactNormal).normalized;

            Vector3 pointVelocity = body.GetPointVelocity(wheel.ContactPoint);
            float lateralSpeed = Vector3.Dot(pointVelocity, lateralAxis);

            float grip = gripCurve.Evaluate(NormalizedSpeed);
            if (input.Brake) grip *= handbrakeGripScale;

            // Scale grip by how loaded the wheel is — an unweighted inside wheel in a
            // corner should not hold the car up.
            grip *= Mathf.Lerp(0.4f, 1f, wheel.CompressionRatio);

            // The acceleration needed to cancel the slide this step, scaled by grip.
            float desiredAcceleration = -lateralSpeed * grip / dt;

            body.AddForceAtPosition(lateralAxis * (desiredAcceleration * tyreMass), wheel.ContactPoint);
        }

        private void ApplyDrive(Wheel wheel)
        {
            Vector3 forwardAxis = Quaternion.AngleAxis(wheel.SteerAngle, transform.up) * transform.forward;
            forwardAxis = Vector3.ProjectOnPlane(forwardAxis, wheel.ContactNormal).normalized;

            if (input.Brake || (input.Throttle < 0f && ForwardSpeed > 0.5f))
            {
                // Braking: oppose whichever way we're actually rolling, and don't
                // overshoot into reverse in a single step.
                float rollingSpeed = Vector3.Dot(body.GetPointVelocity(wheel.ContactPoint), forwardAxis);
                float stopping = -Mathf.Sign(rollingSpeed) * brakeForce;
                body.AddForceAtPosition(forwardAxis * stopping, wheel.ContactPoint);
                return;
            }

            if (!wheel.powered) return;

            if (Mathf.Abs(input.Throttle) < 0.01f)
            {
                // Coasting: gentle drag so the buggy slows rather than gliding forever.
                float rollingSpeed = Vector3.Dot(body.GetPointVelocity(wheel.ContactPoint), forwardAxis);
                body.AddForceAtPosition(forwardAxis * (-Mathf.Sign(rollingSpeed) * rollingResistance),
                    wheel.ContactPoint);
                return;
            }

            float available = powerCurve.Evaluate(NormalizedSpeed) * motorForce;
            if (input.Throttle < 0f) available *= reverseForceScale;

            body.AddForceAtPosition(forwardAxis * (available * input.Throttle), wheel.ContactPoint);
        }

        /// <summary>
        /// Transfers load across each axle so the buggy leans into corners instead of
        /// heeling right over. Cheap stand-in for a real anti-roll bar.
        /// </summary>
        private void ApplyAntiRoll()
        {
            ApplyAntiRollForAxle(0, 1);
            ApplyAntiRollForAxle(2, 3);
        }

        private void ApplyAntiRollForAxle(int leftIndex, int rightIndex)
        {
            if (wheels.Length <= rightIndex) return;

            Wheel left = wheels[leftIndex];
            Wheel right = wheels[rightIndex];
            if (left?.anchor == null || right?.anchor == null) return;

            float leftTravel = left.IsGrounded ? 1f - left.CompressionRatio : 1f;
            float rightTravel = right.IsGrounded ? 1f - right.CompressionRatio : 1f;

            float force = (leftTravel - rightTravel) * antiRollStrength;

            if (left.IsGrounded) body.AddForceAtPosition(left.anchor.up * -force, left.anchor.position);
            if (right.IsGrounded) body.AddForceAtPosition(right.anchor.up * force, right.anchor.position);
        }

        private void ApplyDownforce()
        {
            if (!IsGrounded) return;
            float amount = downforceAtTopSpeed * NormalizedSpeed * NormalizedSpeed;
            body.AddForce(-transform.up * amount);
        }

        /// <summary>
        /// While airborne the wheels have nothing to push against, so we let the player
        /// rotate the buggy directly. This is what makes flips and landing corrections
        /// feel deliberate rather than random.
        /// </summary>
        private void ApplyAirControl()
        {
            body.AddTorque(transform.right * (input.Throttle * airPitchTorque), ForceMode.Force);
            body.AddTorque(-transform.forward * (input.Steer * airRollTorque), ForceMode.Force);
            body.AddTorque(transform.up * (input.Steer * airYawTorque), ForceMode.Force);
        }

        private void ApplyBoost()
        {
            if (boostForce <= 0f) return;
            body.AddForce(transform.forward * boostForce, ForceMode.Force);
            boostForce = 0f;
        }

        /// <summary>
        /// Queue a forward push for this physics step. Called by the boost system and by
        /// boost pads; both funnel through here so the force is applied once, in
        /// FixedUpdate, after the wheel forces.
        /// </summary>
        public void AddBoostForce(float newtons)
        {
            boostForce += newtons;
        }

        /// <summary>
        /// Hard-reset the buggy to a pose. Zeroing velocity matters — without it the
        /// buggy keeps its pre-respawn momentum and immediately crashes again.
        /// </summary>
        public void Teleport(Vector3 position, Quaternion rotation)
        {
            body.velocity = Vector3.zero;
            body.angularVelocity = Vector3.zero;
            body.position = position;
            body.rotation = rotation;

            // Keep the transform in sync for the same frame, so the chase camera doesn't
            // interpolate across the whole track.
            transform.SetPositionAndRotation(position, rotation);

            currentSteerAngle = 0f;
            boostForce = 0f;

            foreach (var wheel in wheels)
            {
                wheel?.Initialise(suspensionRestLength);
            }
        }

        private void SpinGroundedWheel(Wheel wheel, float dt)
        {
            float rollingSpeed = Vector3.Dot(body.GetPointVelocity(wheel.ContactPoint), transform.forward);
            wheel.SpinAngle += (rollingSpeed / (2f * Mathf.PI * wheel.radius)) * 360f * dt;
        }

        private void SpinFreeWheel(Wheel wheel, float dt)
        {
            // Airborne wheels keep spinning at roughly the last road speed so they don't
            // visibly snap to a stop on a jump.
            wheel.SpinAngle += (ForwardSpeed / (2f * Mathf.PI * wheel.radius)) * 360f * dt;
        }

        private void OnCollisionEnter(Collision collision)
        {
            float impulse = collision.impulse.magnitude;
            if (impulse < impactImpulseThreshold) return;

            Vector3 point = collision.contactCount > 0
                ? collision.GetContact(0).point
                : transform.position;

            Impact?.Invoke(point, impulse);
        }

        /// <summary>Suspension state for the current wheel set — read by WheelVisual.</summary>
        public Wheel[] Wheels => wheels;

        public float SuspensionRestLength => suspensionRestLength;
        public float SuspensionMaxTravel => suspensionMaxTravel;

        private void OnDrawGizmosSelected()
        {
            if (wheels == null) return;

            foreach (var wheel in wheels)
            {
                if (wheel?.anchor == null) continue;

                Gizmos.color = wheel.IsGrounded ? Color.green : Color.red;
                Vector3 origin = wheel.anchor.position;
                Vector3 end = origin - wheel.anchor.up * (suspensionRestLength + suspensionMaxTravel);
                Gizmos.DrawLine(origin, end);
                Gizmos.DrawWireSphere(end, wheel.radius);
            }

            if (Application.isPlaying && body != null)
            {
                Gizmos.color = Color.cyan;
                Gizmos.DrawSphere(transform.TransformPoint(body.centerOfMass), 0.12f);
            }
            else
            {
                Gizmos.color = Color.cyan;
                Gizmos.DrawSphere(transform.TransformPoint(centreOfMassOffset), 0.12f);
            }
        }
    }
}
