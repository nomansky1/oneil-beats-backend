using System;
using UnityEngine;

namespace Raceland.Track
{
    /// <summary>
    /// The start/finish gate. Crossing it only counts once every checkpoint on the lap
    /// has been taken — <c>RaceManager</c> enforces that, this component just reports
    /// the crossing.
    /// </summary>
    [RequireComponent(typeof(Collider))]
    public class FinishLine : MonoBehaviour
    {
        [Tooltip("Where the buggy starts the run, and where a respawn goes before the first " +
                 "checkpoint is taken.")]
        [SerializeField] private Transform gridAnchor;

        public Vector3 GridPosition => gridAnchor != null ? gridAnchor.position : transform.position;
        public Quaternion GridRotation => gridAnchor != null ? gridAnchor.rotation : transform.rotation;

        public event Action Crossed;

        private void Reset() => GetComponent<Collider>().isTrigger = true;

        private void Awake() => GetComponent<Collider>().isTrigger = true;

        private void OnTriggerEnter(Collider other)
        {
            if (other.attachedRigidbody == null) return;
            if (!other.attachedRigidbody.CompareTag("Player")) return;

            Crossed?.Invoke();
        }

        private void OnDrawGizmos()
        {
            Gizmos.color = new Color(0.2f, 1f, 0.35f, 0.4f);

            if (TryGetComponent(out BoxCollider box))
            {
                Gizmos.matrix = transform.localToWorldMatrix;
                Gizmos.DrawCube(box.center, box.size);
                Gizmos.matrix = Matrix4x4.identity;
            }

            Gizmos.color = Color.green;
            Gizmos.DrawLine(GridPosition, GridPosition + GridRotation * Vector3.forward * 4f);
        }
    }
}
