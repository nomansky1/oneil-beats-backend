using System;
using UnityEngine;
using UnityEngine.EventSystems;

namespace Raceland.UI
{
    /// <summary>
    /// A UI button that reports whether it is currently held, not just when it was clicked.
    ///
    /// Unity's Button only fires on click, which is wrong for driving controls — you need
    /// "throttle is down right now". This also handles the case that bites every mobile
    /// racer: a finger that slides off the button, or a touch cancelled by the OS, must
    /// release the control. Leaving it stuck on means the buggy accelerates forever.
    /// </summary>
    public class HoldButton : MonoBehaviour,
        IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
    {
        [Tooltip("When on, sliding a finger off the button keeps it held. Useful for a " +
                 "steering button you want to be forgiving about finger drift.")]
        [SerializeField] private bool stayHeldOnExit;

        private int activePointerId = int.MinValue;

        /// <summary>True while a finger or mouse button is down on this control.</summary>
        public bool IsHeld { get; private set; }

        public event Action Pressed;
        public event Action Released;

        public void OnPointerDown(PointerEventData eventData)
        {
            // Track which pointer claimed the button so a second finger landing and
            // lifting elsewhere can't release it. This matters constantly in landscape:
            // both thumbs are on screen at once.
            if (IsHeld) return;

            activePointerId = eventData.pointerId;
            SetHeld(true);
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            if (eventData.pointerId != activePointerId) return;
            Release();
        }

        public void OnPointerExit(PointerEventData eventData)
        {
            if (stayHeldOnExit) return;
            if (eventData.pointerId != activePointerId) return;
            Release();
        }

        private void OnDisable()
        {
            // Being hidden (pause menu opening, HUD swapped out) must not leave the
            // control latched on.
            if (IsHeld) Release();
        }

        private void Release()
        {
            activePointerId = int.MinValue;
            SetHeld(false);
        }

        private void SetHeld(bool held)
        {
            if (IsHeld == held) return;

            IsHeld = held;

            if (held) Pressed?.Invoke();
            else Released?.Invoke();
        }

        /// <summary>Force the control off — used when input is locked during a countdown.</summary>
        public void ForceRelease()
        {
            if (IsHeld) Release();
        }
    }
}
