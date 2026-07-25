# Building and sideloading the APK

Not yet done. No APK has been produced from this repo — there is no Unity installation in
the environment it was written in. The settings below are applied by
`Raceland > Setup > Apply Android Build Settings`; the steps are the ones to follow on
the dev PC.

---

## Prerequisites

Unity 2022.3 LTS with **Android Build Support**, including:

- OpenJDK
- Android SDK & NDK Tools

Install these through Unity Hub (`Installs > ⚙ > Add Modules`). Without them the Android
platform shows as unavailable in Build Settings.

---

## 1. Settings

Run `Raceland > Setup > Apply Everything`, then `Raceland > Setup > Switch Build Target To
Android` (the first switch reimports every asset — expect a long wait).

What gets applied:

| Setting | Value | Why |
|---|---|---|
| Package name | `com.nelson.raceland` | Change in `RacelandProjectSetup.cs` |
| Scripting backend | IL2CPP | Mono can't produce a 64-bit binary |
| Target architecture | ARM64 | Required for modern devices and the Play Store |
| Min SDK | API 26 (Android 8.0) | **Confirm against your test phone** |
| Orientation | Landscape, both ways | Brief §12 |
| Colour space | Linear | The palette is authored against it; gamma washes it out |
| Graphics API | Vulkan, GLES3 fallback | Vulkan where available, GLES3 for older mid-tier |
| Texture format | ASTC | Best quality-per-byte on Android |
| Output | APK, not AAB | The brief wants something sideloadable |

**Verify the physics settings stuck.** `Time.fixedDeltaTime` and gravity are set from
script, which does not reliably persist to `ProjectSettings/`. Check
`Project Settings > Time > Fixed Timestep` reads `0.02` and
`Project Settings > Physics > Gravity` reads `Y = -18`. Set them by hand once if not —
the handling is tuned against those values.

Same for the collision matrix: `Project Settings > Physics > Layer Collision Matrix`,
Vehicle × Debris must be **unticked**.

---

## 2. Keystore

Needed once. A signed APK installs cleanly when sideloaded; an unsigned one does not.

```
Project Settings > Player > Publishing Settings
  > Keystore Manager > Keystore... > Create New > Anywhere
```

Save it **outside the repo** — `.gitignore` blocks `*.keystore`, `*.jks` and
`keystore.properties`, but the safest place for it is not in the project folder at all.

Then in Publishing Settings:

- Tick **Custom Keystore**, select the file, enter the password
- Pick the alias, enter its password

**Back the keystore up somewhere you won't lose it.** Losing it means the app can never
be updated under the same identity — a new keystore is a different app as far as Android
is concerned. There is no recovery for this.

---

## 3. Build

```
File > Build Settings
  > Add Open Scenes   (Raceland_Track01 must be in the list, index 0)
  > Android > Build
```

Save the APK outside the repo, or to `Build/` (gitignored).

For quicker iteration, `Build And Run` with the phone plugged in and USB debugging on
installs and launches it directly.

---

## 4. Sideload

**Over USB:**

1. Phone: `Settings > About phone`, tap Build number 7 times to unlock Developer options
2. `Settings > Developer options > USB debugging` on
3. Plug in, accept the debugging prompt
4. `Build And Run` from Unity, or `adb install -r Raceland.apk`

**Without a cable:** copy the APK to the phone (Drive, email, USB storage), open it in a
file manager, allow "install unknown apps" for that app when prompted.

---

## 5. Check on device

The definition-of-done items that can only be confirmed on the phone:

- [ ] Installs and launches without a signature error
- [ ] Locks to landscape; rotating end-for-end keeps it landscape
- [ ] Touch controls respond, including both thumbs at once
- [ ] No control sticks on when a finger slides off a button
- [ ] Frame rate holds ~60 (enable `Statistics` in the Game view for a rough read;
      use Android GPU Inspector or Unity Profiler over ADB for a real one)
- [ ] Frame rate survives a multi-obstacle wreck with debris on screen
- [ ] Audio plays and the engine pitch tracks speed
- [ ] Respawn works after a flip, a fall, and getting wedged
- [ ] A full lap can be completed and the time saves
- [ ] Screen doesn't dim on a long straight

---

## Troubleshooting

**Gradle build fails on first attempt** — usually a missing SDK component. Open
`Preferences > External Tools` and confirm the Android SDK, NDK and JDK paths are set to
the Unity-installed versions.

**APK installs but shows a black screen** — almost always the render pipeline. Check
`Raceland > Setup > Validate Render Pipeline` and confirm the URP asset is assigned in
Graphics **and** in every Quality level.

**Runs at exactly 30 fps** — `Application.targetFrameRate`. `PerformanceBootstrap` sets
it to 60, so confirm that object is in the scene; Android defaults to 30 without it.

**Everything is untextured magenta** — materials still on the Built-in shader. Run the
Render Pipeline Converter.

**UI labels are blank** — TMP Essential Resources not imported.
`Window > TextMeshPro > Import TMP Essential Resources`, then
`Raceland > Rebuild UI In Current Scene`.
