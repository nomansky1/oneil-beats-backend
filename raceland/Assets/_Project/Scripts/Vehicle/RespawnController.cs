using System;
using Raceland.Core;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Gets the player driving again after a wipeout. Watches for the three ways a run
    /// dies — flipped, fallen off the world, or wedged against scenery — and puts the
    /// buggy back on the track facing forward.
    ///
    /// Each condition has a dwell time so a dramatic-but-recoverable moment (a two-wheel
    /// slide, a big air) doesn't get cut short by an eager respawn.
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class RespawnController : MonoBehaviour
    {
        [Header("Flip detection")]
        [Tooltip("Respawn when the buggy's up vector falls below this against world up. " +
                 "0 is on its side, -1 is fully inverted.")]
        [Range(-1f, 1f)]
        [SerializeField] private float flippedUpDot = 0.1f;

        [Tooltip("Seconds the buggy must stay flipped before it respawns.")]
        [SerializeField] private float flippedGrace = 2.5f;

        [Header("Stuck detection")]
        [Tooltip("Speed below which the buggy counts as stuck, in m/s.")]
        [SerializeField] private float stuckSpeed = 1.2f;

        [Tooltip("Seconds of near-zero movement with the throttle down before respawning.")]
        [SerializeField] private float stuckGrace = 4f;

        [Header("Fall detection")]
        [Tooltip("Respawn immediately if the buggy drops below this world Y.")]
        [SerializeField] private float killPlaneY = -25f;

        [Header("Respawn")]
        [Tooltip("How far above the checkpoint the buggy is placed, so it drops onto its wheels.")]
        [SerializeField] private float respawnHeightOffset = 1.2f;

        [Tooltip("Seconds of frozen input after a respawn, so the player isn't already " +
                 "steering into a wall as they reappear.")]
        [SerializeField] private float respawnInputFreeze = 0.4f;

        private BuggyController buggy;
        private BoostSystem boost;

        private float flippedTimer;
        private float stuckTimer;
        private float freezeTimer;

        private Vector3 respawnPosition;
        private Quaternion respawnRotation;

        /// <summary>Raised after each respawn, with how many have happened this run.</summary>
        public event Action<int> Respawned;

        /// <summary>Respawn count for the results screen — a clean run is worth bragging about.</summary>
        public int RespawnCount { get; private set; }

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            boost = GetComponent<BoostSystem>();
            SetRespawnPoint(transform.position, transform.rotation);
        }

        /// <summary>
        /// Move the respawn anchor. Called by the start line at the beginning of a run and
        /// by each checkpoint as it is passed.
        /// </summary>
        public void SetRespawnPoint(Vector3 position, Quaternion rotation)
        {
            respawnPosition = position;

            // Flatten the stored rotation: a checkpoint placed on a banked corner would
            // otherwise respawn the player already leaning, which reads as a bug.
            Vector3 forward = Vector3.ProjectOnPlane(rotation * Vector3.forward, Vector3.up);
            if (forward.sqrMagnitude < 0.001f) forward = Vector3.forward;
            respawnRotation = Quaternion.LookRotation(forward.normalized, Vector3.up);
        }

        private void Update()
        {
            if (freezeTimer > 0f)
            {
                freezeTimer -= Time.deltaTime;
                if (freezeTimer <= 0f && VehicleInputHub.Instance != null)
                {
                    VehicleInputHub.Instance.InputLocked = false;
                }

                return;
            }

            if (transform.position.y < killPlaneY)
            {
                Respawn();
                return;
            }

            // This component is the sole consumer of the manual-respawn latch — see
            // VehicleInputHub.ConsumeRespawnRequest for why it isn't part of Current.
            if (VehicleInputHub.Instance != null && VehicleInputHub.Instance.ConsumeRespawnRequest())
            {
                Respawn();
                return;
            }

            VehicleInputState input = VehicleInputHub.Instance != null
                ? VehicleInputHub.Instance.Current
                : default;

            UpdateFlipped(Time.deltaTime);
            UpdateStuck(Time.deltaTime, input);
        }

        private void UpdateFlipped(float dt)
        {
            bool flipped = Vector3.Dot(transform.up, Vector3.up) < flippedUpDot;

            // Only count it while the buggy is actually resting on something. Mid-flip
            // over a jump is a stunt, not a wipeout.
            if (flipped && buggy.IsGrounded)
            {
                flippedTimer += dt;
                if (flippedTimer >= flippedGrace) Respawn();
            }
            else
            {
                flippedTimer = 0f;
            }
        }

        private void UpdateStuck(float dt, VehicleInputState input)
        {
            bool tryingToMove = Mathf.Abs(input.Throttle) > 0.1f;
            bool barelyMoving = buggy.Body.velocity.magnitude < stuckSpeed;

            if (tryingToMove && barelyMoving)
            {
                stuckTimer += dt;
                if (stuckTimer >= stuckGrace) Respawn();
            }
            else
            {
                stuckTimer = 0f;
            }
        }

        /// <summary>
        /// Drop the buggy onto the current respawn anchor, upright, stationary, boost
        /// refilled — without any of the respawn bookkeeping.
        ///
        /// This is the single place that knows the vertical offset. The race manager uses
        /// it to put the buggy on the grid; before it existed, the grid placement had its
        /// own copy of the positioning logic without the offset, which spawned the buggy
        /// inside the road surface.
        /// </summary>
        public void PlaceAtRespawnPoint()
        {
            buggy.Teleport(respawnPosition + Vector3.up * respawnHeightOffset, respawnRotation);

            if (boost != null) boost.Refill();

            flippedTimer = 0f;
            stuckTimer = 0f;
        }

        /// <summary>Put the buggy back at the last checkpoint, upright and facing forward.</summary>
        public void Respawn()
        {
            PlaceAtRespawnPoint();

            freezeTimer = respawnInputFreeze;

            if (VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.ClearHeldInput();
                VehicleInputHub.Instance.InputLocked = true;
            }

            RespawnCount++;
            Respawned?.Invoke(RespawnCount);
        }

        /// <summary>Zero the counter at the start of a fresh run.</summary>
        public void ResetForNewRun()
        {
            RespawnCount = 0;
            flippedTimer = 0f;
            stuckTimer = 0f;

            // Drop any in-flight respawn freeze. Restarting mid-freeze would otherwise
            // leave it to expire during the countdown and unlock input early, handing the
            // player control before "GO".
            freezeTimer = 0f;
        }
    }
}
