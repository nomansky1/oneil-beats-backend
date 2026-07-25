using Raceland.Core;
using UnityEngine;
using UnityEngine.UI;

namespace Raceland.UI
{
    /// <summary>
    /// Reads the on-screen driving controls and pushes them into <c>VehicleInputHub</c>
    /// every frame.
    ///
    /// Layout assumption (landscape): steering on the left thumb, throttle/brake/boost on
    /// the right. The auto-accelerate toggle hides the accelerate button when it's on,
    /// because a button that does nothing is worse than no button.
    /// </summary>
    public class TouchControls : MonoBehaviour
    {
        [Header("Steering")]
        [SerializeField] private HoldButton steerLeft;
        [SerializeField] private HoldButton steerRight;

        [Tooltip("How fast the steer axis ramps to full lock when a button is held. " +
                 "Ramping rather than snapping to ±1 is what stops button steering from " +
                 "feeling twitchy.")]
        [SerializeField] private float steerRampSpeed = 4f;

        [Tooltip("How fast the steer axis returns to centre when nothing is held.")]
        [SerializeField] private float steerReturnSpeed = 6f;

        [Header("Drive")]
        [SerializeField] private HoldButton accelerate;
        [SerializeField] private HoldButton reverse;
        [SerializeField] private HoldButton brake;
        [SerializeField] private HoldButton boost;

        [Header("Other")]
        [SerializeField] private Button respawnButton;
        [SerializeField] private Toggle autoAccelerateToggle;

        [Tooltip("Hidden while auto-accelerate is on.")]
        [SerializeField] private GameObject accelerateButtonRoot;

        private float steerAxis;

        private void Start()
        {
            if (respawnButton != null)
            {
                respawnButton.onClick.AddListener(() => VehicleInputHub.Instance?.RequestRespawn());
            }

            if (autoAccelerateToggle != null)
            {
                autoAccelerateToggle.isOn = GameSettings.AutoAccelerate;
                autoAccelerateToggle.onValueChanged.AddListener(SetAutoAccelerate);
            }

            SetAutoAccelerate(GameSettings.AutoAccelerate);
        }

        private void OnDestroy()
        {
            if (respawnButton != null) respawnButton.onClick.RemoveAllListeners();
            if (autoAccelerateToggle != null) autoAccelerateToggle.onValueChanged.RemoveListener(SetAutoAccelerate);
        }

        private void Update()
        {
            VehicleInputHub hub = VehicleInputHub.Instance;
            if (hub == null) return;

            UpdateSteering(hub);

            float throttle = 0f;
            if (accelerate != null && accelerate.IsHeld) throttle += 1f;
            if (reverse != null && reverse.IsHeld) throttle -= 1f;

            hub.SetThrottle(throttle);
            hub.SetBrake(brake != null && brake.IsHeld);
            hub.SetBoost(boost != null && boost.IsHeld);
        }

        private void UpdateSteering(VehicleInputHub hub)
        {
            float target = 0f;
            if (steerLeft != null && steerLeft.IsHeld) target -= 1f;
            if (steerRight != null && steerRight.IsHeld) target += 1f;

            float speed = Mathf.Approximately(target, 0f) ? steerReturnSpeed : steerRampSpeed;
            steerAxis = Mathf.MoveTowards(steerAxis, target, speed * Time.deltaTime);

            hub.SetSteer(steerAxis);
        }

        private void SetAutoAccelerate(bool enabled)
        {
            GameSettings.AutoAccelerate = enabled;

            if (VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.AutoAccelerate = enabled;
            }

            if (accelerateButtonRoot != null) accelerateButtonRoot.SetActive(!enabled);
            if (enabled && accelerate != null) accelerate.ForceRelease();
        }

        /// <summary>Drop every held control. Called when the pause menu opens.</summary>
        public void ReleaseAll()
        {
            steerLeft?.ForceRelease();
            steerRight?.ForceRelease();
            accelerate?.ForceRelease();
            reverse?.ForceRelease();
            brake?.ForceRelease();
            boost?.ForceRelease();

            steerAxis = 0f;
            VehicleInputHub.Instance?.ClearHeldInput();
        }
    }
}
