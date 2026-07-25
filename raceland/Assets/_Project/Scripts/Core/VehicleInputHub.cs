using UnityEngine;

namespace Raceland.Core
{
    /// <summary>
    /// One frame of driver intent. Produced by the on-screen touch controls (and by
    /// the keyboard in the editor), consumed by <c>BuggyController</c>.
    /// </summary>
    public struct VehicleInputState
    {
        /// <summary>-1 (full reverse) .. 1 (full throttle).</summary>
        public float Throttle;

        /// <summary>-1 (left) .. 1 (right).</summary>
        public float Steer;

        /// <summary>Handbrake / hard brake held.</summary>
        public bool Brake;

        /// <summary>Boost held.</summary>
        public bool Boost;
    }

    /// <summary>
    /// Single place the driver's intent lives for the frame.
    ///
    /// The touch UI pushes values in via the Set* methods; the buggy pulls
    /// <see cref="Current"/> out in FixedUpdate. Keeping this as a plain hub (rather
    /// than wiring the UI directly to the vehicle) means the buggy prefab has no
    /// reference to the canvas, so the same prefab works in a scene with no UI at all
    /// — handy for physics tuning scenes.
    /// </summary>
    public class VehicleInputHub : MonoBehaviour
    {
        public static VehicleInputHub Instance { get; private set; }

        [Header("Auto-accelerate")]
        [Tooltip("When on, the buggy drives forward without holding the throttle. " +
                 "Common in mobile racers — frees up a thumb.")]
        [SerializeField] private bool autoAccelerate;

        [Header("Editor testing")]
        [Tooltip("Read WASD / arrows / space in the editor and standalone builds. " +
                 "Has no effect on device.")]
        [SerializeField] private bool keyboardFallback = true;

        // Values written by the touch UI. Kept separate from the keyboard so a stuck
        // UI button can't be masked by (or mask) a keypress.
        private float touchThrottle;
        private float touchSteer;
        private bool touchBrake;
        private bool touchBoost;
        private bool respawnLatch;

        public bool AutoAccelerate
        {
            get => autoAccelerate;
            set => autoAccelerate = value;
        }

        /// <summary>Set true to freeze input — used during countdown and on the results screen.</summary>
        public bool InputLocked { get; set; }

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(this);
                return;
            }

            Instance = this;
        }

        private void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        // ---- Called by the on-screen buttons -------------------------------------

        public void SetThrottle(float value) => touchThrottle = Mathf.Clamp(value, -1f, 1f);
        public void SetSteer(float value) => touchSteer = Mathf.Clamp(value, -1f, 1f);
        public void SetBrake(bool held) => touchBrake = held;
        public void SetBoost(bool held) => touchBoost = held;
        public void RequestRespawn() => respawnLatch = true;

        /// <summary>Drop every held control. Called when the game is paused or the round ends.</summary>
        public void ClearHeldInput()
        {
            touchThrottle = 0f;
            touchSteer = 0f;
            touchBrake = false;
            touchBoost = false;
        }

        // ---- Consumed by the vehicle ---------------------------------------------

        /// <summary>
        /// The driver's intent for this physics step. Safe to read from as many callers
        /// as you like, as often as you like — reading has no side effects. The one-shot
        /// respawn request deliberately lives outside this, in
        /// <see cref="ConsumeRespawnRequest"/>.
        /// </summary>
        public VehicleInputState Current
        {
            get
            {
                if (InputLocked) return default;

                var state = new VehicleInputState
                {
                    Throttle = touchThrottle,
                    Steer = touchSteer,
                    Brake = touchBrake,
                    Boost = touchBoost
                };

                if (keyboardFallback) ApplyKeyboard(ref state);

                // Auto-accelerate only fills in *forward* intent. If the player is
                // actively reversing or braking we leave them alone, otherwise the
                // toggle would fight the reverse button.
                if (autoAccelerate && state.Throttle >= 0f && !state.Brake)
                {
                    state.Throttle = 1f;
                }

                return state;
            }
        }

        /// <summary>
        /// Take the pending manual-respawn request, if there is one, and clear it.
        ///
        /// This is deliberately separate from <see cref="Current"/>. It is a one-shot
        /// latch, so whoever reads it destroys it — and two components read driver input
        /// every frame (the buggy in FixedUpdate, the respawn controller in Update).
        /// If the latch lived in Current, whichever ran first would swallow the request
        /// and the RESET button would fire only some of the time. Exactly one caller
        /// consumes it: RespawnController.
        /// </summary>
        public bool ConsumeRespawnRequest()
        {
            bool requested = respawnLatch;
            respawnLatch = false;

            return requested && !InputLocked;
        }

        private void Update()
        {
            // Polled here rather than inside the Current getter. GetKeyDown is true for
            // exactly one frame, but FixedUpdate can run zero or several times per frame,
            // so reading it from a property that FixedUpdate calls would drop or duplicate
            // the press depending on frame rate.
            if (keyboardFallback && Input.GetKeyDown(KeyCode.R)) RequestRespawn();
        }

        private void ApplyKeyboard(ref VehicleInputState state)
        {
            float keyThrottle = 0f;
            if (Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)) keyThrottle += 1f;
            if (Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)) keyThrottle -= 1f;

            float keySteer = 0f;
            if (Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow)) keySteer += 1f;
            if (Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)) keySteer -= 1f;

            // Keyboard wins only where it is actually being pressed, so touch and
            // keyboard can coexist while tuning on a dev PC.
            if (!Mathf.Approximately(keyThrottle, 0f)) state.Throttle = Mathf.Clamp(keyThrottle, -1f, 1f);
            if (!Mathf.Approximately(keySteer, 0f)) state.Steer = Mathf.Clamp(keySteer, -1f, 1f);

            if (Input.GetKey(KeyCode.Space)) state.Brake = true;
            if (Input.GetKey(KeyCode.LeftShift)) state.Boost = true;
        }
    }
}
