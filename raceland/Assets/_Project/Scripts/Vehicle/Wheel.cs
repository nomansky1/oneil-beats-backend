using System;
using UnityEngine;

namespace Raceland.Vehicle
{
    /// <summary>
    /// One raycast-suspension corner of the buggy.
    ///
    /// We use raycasts rather than WheelColliders on purpose: WheelColliders bring a
    /// friction model tuned for realism that fights the springy, exaggerated feel the
    /// brief asks for, and they are notoriously fiddly to tune. A spring + damper cast
    /// gives us a handful of numbers that map directly onto how the car *feels*.
    /// </summary>
    [Serializable]
    public class Wheel
    {
        [Tooltip("Empty transform at the top of the suspension travel. The cast starts here.")]
        public Transform anchor;

        [Tooltip("Wheel mesh. Moved to the contact point, spun, and steered by WheelVisual.")]
        public Transform visual;

        [Tooltip("Front wheels steer. Rear wheels do not.")]
        public bool steers;

        [Tooltip("Which wheels receive engine torque. All four = the most forgiving arcade feel.")]
        public bool powered = true;

        [Tooltip("Wheel radius in metres. Must match the art or the buggy will float / sink.")]
        public float radius = 0.45f;

        // ---- Runtime state (not serialized, but public for the debug gizmos) ----

        [NonSerialized] public bool IsGrounded;
        [NonSerialized] public Vector3 ContactPoint;
        [NonSerialized] public Vector3 ContactNormal;
        [NonSerialized] public float CompressionRatio; // 0 = fully extended, 1 = bottomed out
        [NonSerialized] public float SpinAngle;        // degrees, for the visual
        [NonSerialized] public float SteerAngle;       // degrees, for the visual

        /// <summary>Spring length this physics step. Drives where the wheel mesh sits.</summary>
        [NonSerialized] public float CurrentLength;

        /// <summary>Spring length last physics step, used to derive damper velocity.</summary>
        [NonSerialized] public float PreviousLength;

        /// <summary>Set once at startup so the first step's damper term isn't a spike.</summary>
        public void Initialise(float restLength)
        {
            PreviousLength = restLength;
            CurrentLength = restLength;
            CompressionRatio = 0f;
            IsGrounded = false;
        }

        /// <summary>
        /// Where the wheel visual should sit given the current suspension length.
        /// </summary>
        public Vector3 VisualPosition(float currentLength)
        {
            return anchor.position - anchor.up * currentLength;
        }
    }
}
