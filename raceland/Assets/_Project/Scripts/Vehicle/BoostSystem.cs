using System;
using Raceland.Core;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Boost meter and the forward shove it buys. Two ways to spend it: hold the boost
    /// button (drains the meter), or hit a boost pad (free, fixed-duration burst that
    /// doesn't touch the meter).
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class BoostSystem : MonoBehaviour
    {
        [Header("Meter")]
        [Tooltip("Seconds of continuous boost from a full meter.")]
        [SerializeField] private float capacity = 3.5f;

        [Tooltip("Meter units refilled per second while not boosting.")]
        [SerializeField] private float rechargeRate = 0.5f;

        [Tooltip("Delay after boosting before the meter starts refilling.")]
        [SerializeField] private float rechargeDelay = 1.2f;

        [Tooltip("The meter must reach at least this fraction before boost can be used again. " +
                 "Stops the player from stutter-tapping an empty meter.")]
        [Range(0f, 1f)]
        [SerializeField] private float minimumChargeToFire = 0.15f;

        [Header("Force")]
        [Tooltip("Forward force while the boost button is held, in newtons.")]
        [SerializeField] private float boostForce = 14000f;

        [Tooltip("Forward force from a boost pad, in newtons.")]
        [SerializeField] private float padForce = 22000f;

        [Tooltip("How long a single boost pad keeps pushing.")]
        [SerializeField] private float padDuration = 1.1f;

        private BuggyController buggy;
        private float charge;
        private float rechargeTimer;
        private float padTimer;

        /// <summary>Meter fill, 0..1. Drives the HUD gauge.</summary>
        public float NormalizedCharge => capacity <= 0f ? 0f : Mathf.Clamp01(charge / capacity);

        /// <summary>True while boost force is being applied, from either source.</summary>
        public bool IsBoosting { get; private set; }

        /// <summary>Raised when boost starts, so audio and the camera FOV punch can react.</summary>
        public event Action BoostStarted;

        /// <summary>Raised when boost stops from any cause, including running the meter dry.</summary>
        public event Action BoostEnded;

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            charge = capacity;
        }

        private void FixedUpdate()
        {
            bool wasBoosting = IsBoosting;
            IsBoosting = false;

            float dt = Time.fixedDeltaTime;

            if (padTimer > 0f)
            {
                padTimer -= dt;
                buggy.AddBoostForce(padForce);
                IsBoosting = true;
            }

            bool wantsBoost = VehicleInputHub.Instance != null && VehicleInputHub.Instance.Current.Boost;

            if (wantsBoost && charge > 0f && (wasBoosting || NormalizedCharge >= minimumChargeToFire))
            {
                charge = Mathf.Max(0f, charge - dt);
                rechargeTimer = rechargeDelay;
                buggy.AddBoostForce(boostForce);
                IsBoosting = true;
            }
            else if (padTimer <= 0f)
            {
                if (rechargeTimer > 0f) rechargeTimer -= dt;
                else charge = Mathf.Min(capacity, charge + rechargeRate * dt);
            }

            if (IsBoosting && !wasBoosting) BoostStarted?.Invoke();
            else if (!IsBoosting && wasBoosting) BoostEnded?.Invoke();
        }

        /// <summary>Called by <c>BoostPad</c> when the buggy drives over it.</summary>
        public void TriggerPadBoost()
        {
            padTimer = padDuration;
        }

        /// <summary>Refill the meter — used on respawn so a bad crash isn't doubly punishing.</summary>
        public void Refill()
        {
            charge = capacity;
            rechargeTimer = 0f;
            padTimer = 0f;
        }
    }
}
