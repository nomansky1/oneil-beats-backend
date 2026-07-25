using System;
using UnityEngine;

namespace Raceland.Track
{
    /// <summary>
    /// A gate the player must pass through. Checkpoints do two jobs: they prove the lap
    /// was driven properly (you can't cut the course), and they define where a wipeout
    /// puts you back.
    ///
    /// Place the trigger volume wide and tall enough to catch a buggy that arrives
    /// sideways, upside down, or airborne — a missed checkpoint that silently invalidates
    /// a good lap is the most frustrating bug this system can have.
    /// </summary>
    [RequireComponent(typeof(Collider))]
    public class Checkpoint : MonoBehaviour
    {
        [Tooltip("Order around the track, starting at 0. The finish line is handled " +
                 "separately by RaceManager — don't give it a checkpoint.")]
        [SerializeField] private int index;

        [Tooltip("Where the buggy is placed when respawning here. Leave empty to respawn " +
                 "at the checkpoint's own transform. Use a child transform when the gate " +
                 "sits off to the side of the racing line.")]
        [SerializeField] private Transform respawnAnchor;

        [Tooltip("Optional mesh tinted when the checkpoint is armed vs already taken.")]
        [SerializeField] private Renderer indicator;

        [SerializeField] private Color armedColour = new Color(1f, 0.62f, 0.15f);
        [SerializeField] private Color takenColour = new Color(0.35f, 0.35f, 0.32f);

        private MaterialPropertyBlock propertyBlock;

        public int Index => index;

        public Vector3 RespawnPosition => respawnAnchor != null ? respawnAnchor.position : transform.position;
        public Quaternion RespawnRotation => respawnAnchor != null ? respawnAnchor.rotation : transform.rotation;

        /// <summary>Raised when the player drives through. Handled by <c>RaceManager</c>.</summary>
        public event Action<Checkpoint> Passed;

        private void Reset()
        {
            // Checkpoints are gates, not obstacles.
            GetComponent<Collider>().isTrigger = true;
        }

        private void Awake()
        {
            GetComponent<Collider>().isTrigger = true;
            propertyBlock = new MaterialPropertyBlock();
        }

        private void OnTriggerEnter(Collider other)
        {
            // Match on the rigidbody so a trigger hit against any of the buggy's child
            // colliders still counts.
            if (other.attachedRigidbody == null) return;
            if (!other.attachedRigidbody.CompareTag("Player")) return;

            Passed?.Invoke(this);
        }

        /// <summary>Tint the gate. Called by the race manager as the lap progresses.</summary>
        public void SetArmed(bool armed)
        {
            if (indicator == null) return;

            indicator.GetPropertyBlock(propertyBlock);

            // A property block rather than a material instance: tinting per-checkpoint via
            // .material would clone the material and break batching across the whole set.
            propertyBlock.SetColor("_BaseColor", armed ? armedColour : takenColour);
            propertyBlock.SetColor("_Color", armed ? armedColour : takenColour);
            indicator.SetPropertyBlock(propertyBlock);
        }

        private void OnDrawGizmos()
        {
            Gizmos.color = new Color(1f, 0.62f, 0.15f, 0.35f);

            if (TryGetComponent(out BoxCollider box))
            {
                Gizmos.matrix = transform.localToWorldMatrix;
                Gizmos.DrawCube(box.center, box.size);
                Gizmos.matrix = Matrix4x4.identity;
            }

            Gizmos.color = Color.yellow;
            Vector3 anchor = RespawnPosition;
            Gizmos.DrawLine(anchor, anchor + RespawnRotation * Vector3.forward * 3f);
        }
    }
}
