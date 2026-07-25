using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// Drives the wheel meshes from the suspension state the physics rig computed.
    ///
    /// Runs in LateUpdate rather than FixedUpdate so the wheels track the interpolated
    /// body transform — otherwise they visibly judder relative to the chassis at frame
    /// rates that don't line up with the physics step.
    /// </summary>
    [RequireComponent(typeof(BuggyController))]
    public class WheelVisual : MonoBehaviour
    {
        [Tooltip("How quickly the wheel mesh chases the suspension length. Smoothing here " +
                 "hides the single-step pops you get when a wheel clips a kerb.")]
        [SerializeField] private float positionSmoothing = 20f;

        private BuggyController buggy;
        private float[] smoothedLengths;

        private void Awake()
        {
            buggy = GetComponent<BuggyController>();
            smoothedLengths = new float[buggy.Wheels.Length];

            for (int i = 0; i < smoothedLengths.Length; i++)
            {
                smoothedLengths[i] = buggy.SuspensionRestLength;
            }
        }

        private void LateUpdate()
        {
            Wheel[] wheels = buggy.Wheels;
            float smoothing = 1f - Mathf.Exp(-positionSmoothing * Time.deltaTime);

            for (int i = 0; i < wheels.Length; i++)
            {
                Wheel wheel = wheels[i];
                if (wheel?.anchor == null || wheel.visual == null) continue;

                smoothedLengths[i] = Mathf.Lerp(smoothedLengths[i], wheel.CurrentLength, smoothing);

                wheel.visual.position = wheel.anchor.position - wheel.anchor.up * smoothedLengths[i];
                wheel.visual.rotation = wheel.anchor.rotation
                                        * Quaternion.Euler(wheel.SpinAngle, wheel.SteerAngle, 0f);
            }
        }
    }
}
