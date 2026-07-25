# Tuning the handling

Every number below is a starting point derived from arithmetic, not from driving. The
buggy has never been driven. Treat this as a map of which knob to reach for, not as a
claim that the current values feel good.

All values live on the `Buggy` object in the scene, mostly on `BuggyController`.

---

## Symptom → knob

| It feels like | Reach for | Direction |
|---|---|---|
| Rolls over in every corner | `centreOfMassOffset.y` | More negative (currently −0.55) |
| Never rolls, even off a big landing | `centreOfMassOffset.y` | Towards zero |
| Bounces / pogos over bumps | `springDamper` | Up (currently 3800) |
| Feels dead, no body movement | `springDamper` | Down |
| Bottoms out on landings | `springStrength`, `suspensionMaxTravel` | Up |
| Floats, too soft | `springStrength` | Up (currently 42000) |
| Grips like a slot car, won't slide | `gripCurve` high-speed end | Down from 0.55 |
| Slides constantly, can't hold a line | `gripCurve`, `tyreMass` | Up |
| Won't drift off the handbrake | `handbrakeGripScale` | Down (currently 0.35) |
| Too slow off the line | `motorForce` | Up (currently 5200/wheel) |
| Top speed too low | `topSpeed`, `powerCurve` tail | Up |
| Twitchy at speed | `minSteerAngle` | Down (currently 12°) |
| Won't turn at low speed | `maxSteerAngle` | Up (currently 32°) |
| Steering feels laggy | `steerResponse` | Up (currently 8) |
| Jumps float, hang time too long | `Physics.gravity.y` | More negative (currently −18) |
| Can't control rotation in the air | `airPitchTorque`, `airRollTorque` | Up |
| Spins wildly in the air | same | Down |
| Gets airborne over small bumps | `downforceAtTopSpeed` | Up (currently 5500) |
| Body leans too far in corners | `antiRollStrength` | Up (currently 9000) |

---

## The relationships worth knowing

**Springs are sized against static load.** Each wheel carries
`mass × gravity ÷ 4` = `1200 × 18 ÷ 4` = 5400 N. At 42000 N/m that's 0.129 m of
compression, about 23% of the 0.55 m rest length — roughly right. Change the mass and the
spring rate has to move with it or the ride height goes wrong.

**Gravity is −18, not −9.81.** Real gravity makes arcade jumps feel like the moon. Heavier
gravity gives snappy, weighty landings. If you change it, the spring rate needs to change
too, by the same ratio.

**Grip is a velocity-cancelling force, not a friction coefficient.** `gripCurve` is the
fraction of the sideways slide cancelled each physics step. 1.0 is a slot car; 0.0 is ice.
The falloff towards high speed is what lets the back step out.

**Wheel radius must match the art.** `Wheel.radius` (0.45) is used both to position the
mesh and to offset the suspension cast. Get it wrong and the buggy floats above the road
or sinks into it. This is the first thing to check after swapping in the Rodin wheels.

**The physics step is part of the tuning.** Everything is tuned against a 0.02 s fixed
timestep. Changing it changes the feel, because the grip force is derived per-step.

---

## Camera

On `ChaseCamera`:

| It feels like | Reach for |
|---|---|
| Not enough sense of speed | `topSpeedFov` up (78), `lookAheadAtTopSpeed` up |
| Motion sickness / too much FOV swing | `topSpeedFov` down, `fovSmoothing` down |
| Camera lags behind | `positionSmoothing` up (6) |
| Camera is rigid, no weight | `positionSmoothing` down |
| Lose orientation during a roll | `uprightBlendThreshold` up (0.35) |
| Impacts feel weak | `maxShakeAmplitude` up, `impulseForMaxShake` down |

---

## Damage

On `DamageableBody`:

- `detachImpulse` per panel — how hard a hit has to be. Bumper 70, bonnet 55, side panels
  45. Raise all of them if the buggy strips itself on light contact.
- `maxPanelsPerImpact` (2) — stops a head-on wreck removing every panel in one frame.
- Panels do **not** change the collision shape or mass when they come off. That's
  deliberate: cosmetic damage keeps crashes feeling consistent.

On `Destructible` (obstacles):

- `breakImpulse` (25) — tyre stacks should be low, concrete high.
- `halfLifetime` (4 s) — obstacle debris is the main source of stray rigidbodies. If the
  frame rate drops during a messy run, lower this first.

---

## Boost

On `BoostSystem`:

- `capacity` (3.5 s) and `rechargeRate` (0.5/s) set how often boost is available. A 7:1
  recharge-to-use ratio is stingy — loosen it if boost feels unavailable.
- `boostForce` (14000 N) is about 11.7 m/s² on top of the engine.
- `padForce` (22000 N) for `padDuration` (1.1 s) — pads are free and don't touch the
  meter.
- `minimumChargeToFire` (0.15) stops stutter-tapping an empty meter.

---

## Where to start

1. Get the buggy driving in a straight line at a speed that feels right — `motorForce`,
   `topSpeed`, `powerCurve`.
2. Then corners — `gripCurve`, `centreOfMassOffset`, steering angles.
3. Then jumps — gravity, `airPitchTorque`, suspension travel.
4. Then the camera, which will mask or expose all of the above.
5. Damage and boost last. They're flavour on top of handling that already works.
