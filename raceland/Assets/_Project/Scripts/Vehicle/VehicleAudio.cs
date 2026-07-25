using Raceland.Core;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Engine loop, crash hits and boost whoosh. Every clip is optional — the vehicle
    /// runs silently if a slot is empty, so the first playable build doesn't have to wait
    /// on audio sourcing.
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class VehicleAudio : MonoBehaviour
    {
        [Header("Sources")]
        [Tooltip("Looping engine source. Leave the clip empty until real audio lands.")]
        [SerializeField] private AudioSource engineSource;

        [Tooltip("One-shot source for crashes, boosts and panel tears.")]
        [SerializeField] private AudioSource effectSource;

        [Header("Clips")]
        [SerializeField] private AudioClip engineLoop;
        [SerializeField] private AudioClip[] impactClips;
        [SerializeField] private AudioClip boostWhoosh;
        [SerializeField] private AudioClip panelTear;

        [Header("Engine pitch")]
        [Tooltip("Engine pitch at a standstill.")]
        [SerializeField] private float idlePitch = 0.75f;

        [Tooltip("Engine pitch at top speed.")]
        [SerializeField] private float topPitch = 2.1f;

        [Tooltip("Extra pitch on top while boosting.")]
        [SerializeField] private float boostPitchBonus = 0.25f;

        [Tooltip("How fast the pitch chases the target. Slower makes the engine feel heavier.")]
        [SerializeField] private float pitchResponse = 6f;

        [Header("Engine volume")]
        [SerializeField] private float idleVolume = 0.35f;
        [SerializeField] private float topVolume = 0.8f;

        [Header("Impacts")]
        [Tooltip("Collision impulse that maps to full-volume crash audio.")]
        [SerializeField] private float impactImpulseForFullVolume = 90f;

        [Tooltip("Minimum seconds between crash sounds, so a scrape along a barrier " +
                 "doesn't machine-gun the same clip.")]
        [SerializeField] private float impactCooldown = 0.15f;

        private BuggyController buggy;
        private BoostSystem boost;
        private DamageableBody damage;
        private float lastImpactTime = -99f;

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            boost = GetComponent<BoostSystem>();
            damage = GetComponent<DamageableBody>();

            if (engineSource != null)
            {
                engineSource.clip = engineLoop;
                engineSource.loop = true;
                engineSource.playOnAwake = false;
                engineSource.spatialBlend = 0f; // The player's own engine sits in 2D.
                if (engineLoop != null) engineSource.Play();
            }
        }

        private void OnEnable()
        {
            buggy.Impact += HandleImpact;
            if (boost != null) boost.BoostStarted += HandleBoostStarted;
            if (damage != null) damage.PanelDetached += HandlePanelDetached;
        }

        private void OnDisable()
        {
            buggy.Impact -= HandleImpact;
            if (boost != null) boost.BoostStarted -= HandleBoostStarted;
            if (damage != null) damage.PanelDetached -= HandlePanelDetached;
        }

        private void Update()
        {
            if (engineSource == null || engineLoop == null) return;

            float speed = buggy.NormalizedSpeed;

            float targetPitch = Mathf.Lerp(idlePitch, topPitch, speed);
            if (boost != null && boost.IsBoosting) targetPitch += boostPitchBonus;

            // Airborne wheels have no load, so the engine flares — a small, cheap detail
            // that sells the jump.
            if (buggy.IsAirborne) targetPitch += 0.15f;

            float blend = 1f - Mathf.Exp(-pitchResponse * Time.deltaTime);
            engineSource.pitch = Mathf.Lerp(engineSource.pitch, targetPitch, blend);
            engineSource.volume = Mathf.Lerp(idleVolume, topVolume, speed);
        }

        private void HandleImpact(Vector3 point, float impulse)
        {
            if (effectSource == null || impactClips == null || impactClips.Length == 0) return;
            if (Time.time - lastImpactTime < impactCooldown) return;

            lastImpactTime = Time.time;

            AudioClip clip = impactClips[Random.Range(0, impactClips.Length)];
            float volume = Mathf.Clamp01(impulse / impactImpulseForFullVolume);
            effectSource.PlayOneShot(clip, volume);
        }

        private void HandleBoostStarted()
        {
            if (effectSource == null || boostWhoosh == null) return;
            effectSource.PlayOneShot(boostWhoosh, 0.7f);
        }

        private void HandlePanelDetached(Vector3 position)
        {
            if (effectSource == null || panelTear == null) return;
            effectSource.PlayOneShot(panelTear, 0.6f);
        }
    }
}
