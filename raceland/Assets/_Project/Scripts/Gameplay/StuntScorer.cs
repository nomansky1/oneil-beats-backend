using System;
using System.Collections.Generic;
using Raceland.Track;
using Raceland.Vehicle;
using UnityEngine;

namespace Raceland.Gameplay
{
    /// <summary>
    /// Scores the chaos: air time, flips, near misses and wrecked obstacles.
    ///
    /// Sits on the buggy in both modes. In stunt mode it's the objective; in time trial
    /// it still runs, so the HUD can show a bonus score alongside the timer without a
    /// second code path. It listens to the same physics events the camera and audio use
    /// rather than doing its own collision work.
    ///
    /// A trick only banks when the buggy lands cleanly. Crash out mid-flip and the
    /// pending points are lost — that risk is the whole reason a stunt mode is fun.
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class StuntScorer : MonoBehaviour
    {
        [Header("Air time")]
        [Tooltip("Airborne time below this doesn't count — kerbs and bumps shouldn't score.")]
        [SerializeField] private float minimumAirTime = 0.55f;

        [Tooltip("Points per second airborne.")]
        [SerializeField] private int pointsPerAirSecond = 120;

        [Header("Flips")]
        [Tooltip("Points for each completed 360 of pitch (front/back flip).")]
        [SerializeField] private int pointsPerFrontFlip = 500;

        [Tooltip("Points for each completed 360 of roll (barrel roll).")]
        [SerializeField] private int pointsPerBarrelRoll = 400;

        [Header("Near misses")]
        [Tooltip("How close the buggy must pass to an obstacle to count as a near miss.")]
        [SerializeField] private float nearMissRadius = 3f;

        [Tooltip("Minimum speed for a near miss to count, in m/s. Crawling past a wreck " +
                 "isn't a near miss.")]
        [SerializeField] private float nearMissMinSpeed = 12f;

        [SerializeField] private int pointsPerNearMiss = 150;

        [Tooltip("Layers scanned for near-miss candidates. Should be the obstacle layer only.")]
        [SerializeField] private LayerMask nearMissMask;

        [Tooltip("Seconds between near-miss scans. This is an OverlapSphere, so don't run " +
                 "it every frame on a phone.")]
        [SerializeField] private float nearMissScanInterval = 0.1f;

        [Header("Wrecks")]
        [SerializeField] private int pointsPerWreck = 250;

        [Header("Landing")]
        [Tooltip("Landing more upright than this banks the pending trick. Below it, the " +
                 "landing counts as a crash and the pending points are lost.")]
        [Range(0f, 1f)]
        [SerializeField] private float cleanLandingUpDot = 0.55f;

        [Tooltip("Multiplier growth per trick banked without touching down badly.")]
        [SerializeField] private float comboStep = 0.25f;

        [SerializeField] private float maxComboMultiplier = 4f;

        private BuggyController buggy;

        private float airTime;
        private float pitchDegrees;
        private float rollDegrees;
        private int pendingPoints;

        // Obstacle -> whether we actually hit it. Anything that leaves the radius
        // un-hit scores a near miss.
        private readonly Dictionary<Collider, bool> nearMissCandidates = new Dictionary<Collider, bool>();
        private readonly List<Collider> expiredCandidates = new List<Collider>();
        private readonly Collider[] overlapBuffer = new Collider[16];
        private float nextScanTime;

        /// <summary>Banked score for the run.</summary>
        public int Score { get; private set; }

        /// <summary>Points earned in the air but not yet landed. Shown greyed out on the HUD.</summary>
        public int PendingPoints => pendingPoints;

        public float ComboMultiplier { get; private set; } = 1f;

        /// <summary>Raised when points bank, with the amount and a short label for the HUD popup.</summary>
        public event Action<int, string> Scored;

        /// <summary>Raised when a crash landing wipes out pending points.</summary>
        public event Action<int> TrickLost;

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            ComboMultiplier = 1f;
        }

        private void OnEnable()
        {
            buggy.Landed += HandleLanded;
            Destructible.AnyShattered += HandleObstacleShattered;
        }

        private void OnDisable()
        {
            buggy.Landed -= HandleLanded;
            Destructible.AnyShattered -= HandleObstacleShattered;
        }

        private void FixedUpdate()
        {
            float dt = Time.fixedDeltaTime;

            if (buggy.IsAirborne)
            {
                airTime += dt;

                Vector3 angularVelocity = buggy.Body.angularVelocity;
                pitchDegrees += Vector3.Dot(angularVelocity, transform.right) * Mathf.Rad2Deg * dt;
                rollDegrees += Vector3.Dot(angularVelocity, transform.forward) * Mathf.Rad2Deg * dt;
            }

            if (Time.time >= nextScanTime)
            {
                nextScanTime = Time.time + nearMissScanInterval;
                ScanForNearMisses();
            }
        }

        private void HandleLanded(float verticalImpact)
        {
            if (airTime < minimumAirTime)
            {
                ResetAirState();
                return;
            }

            bool cleanLanding = Vector3.Dot(transform.up, Vector3.up) >= cleanLandingUpDot;

            int airPoints = Mathf.RoundToInt(airTime * pointsPerAirSecond);
            int flipPoints = Mathf.FloorToInt(Mathf.Abs(pitchDegrees) / 360f) * pointsPerFrontFlip
                             + Mathf.FloorToInt(Mathf.Abs(rollDegrees) / 360f) * pointsPerBarrelRoll;

            pendingPoints += airPoints + flipPoints;

            if (cleanLanding)
            {
                Bank(pendingPoints, DescribeTrick(flipPoints));
                ComboMultiplier = Mathf.Min(maxComboMultiplier, ComboMultiplier + comboStep);
            }
            else
            {
                TrickLost?.Invoke(pendingPoints);
                ComboMultiplier = 1f;
            }

            pendingPoints = 0;
            ResetAirState();
        }

        private string DescribeTrick(int flipPoints)
        {
            if (flipPoints <= 0) return "AIR";

            bool flipped = Mathf.Abs(pitchDegrees) >= 360f;
            bool rolled = Mathf.Abs(rollDegrees) >= 360f;

            if (flipped && rolled) return "INSANE COMBO";
            return flipped ? "FLIP" : "BARREL ROLL";
        }

        private void ResetAirState()
        {
            airTime = 0f;
            pitchDegrees = 0f;
            rollDegrees = 0f;
        }

        private void ScanForNearMisses()
        {
            bool fastEnough = buggy.Body.velocity.magnitude >= nearMissMinSpeed;

            int count = Physics.OverlapSphereNonAlloc(
                transform.position, nearMissRadius, overlapBuffer, nearMissMask,
                QueryTriggerInteraction.Ignore);

            // Clamped: the documented return is the number stored, but it has historically
            // been the number found on some versions, which would overrun the buffer.
            count = Mathf.Min(count, overlapBuffer.Length);

            for (int i = 0; i < count; i++)
            {
                Collider candidate = overlapBuffer[i];
                if (candidate == null) continue;
                if (!fastEnough) continue;

                if (!nearMissCandidates.ContainsKey(candidate))
                {
                    nearMissCandidates[candidate] = false;
                }
            }

            // Anything no longer in range (or destroyed) resolves now.
            expiredCandidates.Clear();

            foreach (KeyValuePair<Collider, bool> entry in nearMissCandidates)
            {
                Collider candidate = entry.Key;

                if (candidate == null || !candidate.gameObject.activeInHierarchy)
                {
                    expiredCandidates.Add(candidate);
                    continue;
                }

                float distance = Vector3.Distance(transform.position, candidate.transform.position);
                if (distance > nearMissRadius * 1.5f)
                {
                    expiredCandidates.Add(candidate);

                    if (!entry.Value) Bank(pointsPerNearMiss, "NEAR MISS");
                }
            }

            foreach (Collider expired in expiredCandidates)
            {
                nearMissCandidates.Remove(expired);
            }
        }

        private void OnCollisionEnter(Collision collision)
        {
            // Touching a candidate disqualifies it — a hit is not a near miss.
            if (collision.collider != null && nearMissCandidates.ContainsKey(collision.collider))
            {
                nearMissCandidates[collision.collider] = true;
            }
        }

        private void HandleObstacleShattered(Vector3 position, float impulse)
        {
            Bank(pointsPerWreck, "WRECKED");
        }

        private void Bank(int basePoints, string label)
        {
            if (basePoints <= 0) return;

            int awarded = Mathf.RoundToInt(basePoints * ComboMultiplier);
            Score += awarded;
            Scored?.Invoke(awarded, label);
        }

        /// <summary>Clear the run's score. Called by the race manager on a fresh start.</summary>
        public void ResetScore()
        {
            Score = 0;
            pendingPoints = 0;
            ComboMultiplier = 1f;
            ResetAirState();
            nearMissCandidates.Clear();
        }
    }
}
