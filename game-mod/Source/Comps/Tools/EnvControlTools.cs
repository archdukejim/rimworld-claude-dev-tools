using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using RimWorld;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Environment / scene-staging tools: force the conditions a visual test needs (night, rain),
    /// point the camera, sample the *rendered* light + weather at a cell, and build a room in one
    /// call instead of dozens of spawns.
    ///
    /// Why these exist (session retro): verifying a skylight meant a human eyeballing the lighting
    /// overlay because nothing reported rendered brightness; night/rain couldn't be forced so a
    /// moonlight tint or a rain-hiding fix couldn't be checked at all; and a walled test room was
    /// 25 individual spawn_thing calls rebuilt on every relaunch. inspect_thing_at already returns
    /// gameplay glow — sample_environment adds the sky/weather/celestial side so an agent can
    /// self-verify a visual without a screenshot, and set_time / set_weather force the conditions
    /// that make the check meaningful.
    ///
    /// Like MapBuildTools these run on the Unity main thread (dispatched through the GameComponent's
    /// main-thread queue), so touching Map/SkyManager/TickManager state directly is safe. Shared
    /// helpers (RequireMapError, ArgInt, ArgStr, SafeInspect) live in the MapBuildTools partial.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        // RimWorld clock: 2500 ticks per in-game hour, 60000 per day. Jumping the tick clock by a
        // whole number of hours advances local time-of-day by that many hours on any map, regardless
        // of its longitude offset (the offset cancels in the delta).
        private const int TicksPerHour = 2500;

        private static float ArgFloat(Dictionary<string, object> d, string key, float fallback)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null)
            {
                try { return Convert.ToSingle(v); } catch { }
            }
            return fallback;
        }

        private static bool ArgHas(Dictionary<string, object> d, string key)
        {
            return d != null && d.TryGetValue(key, out var v) && v != null &&
                   !string.IsNullOrEmpty(v.ToString().Trim());
        }

        /// <summary>Resolve a weather by friendly alias or exact defName. Null when unknown.</summary>
        private static WeatherDef ResolveWeather(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            switch (key.ToLowerInvariant())
            {
                case "clear": case "sunny": return WeatherDefOf.Clear;
                case "fog": case "foggy": return WeatherDefOf.Fog;
                case "foggyrain": return WeatherDefOf.FoggyRain;
                case "rain": return DefDatabase<WeatherDef>.GetNamedSilentFail("Rain");
                case "rainythunderstorm": case "thunderstorm": case "storm":
                    return DefDatabase<WeatherDef>.GetNamedSilentFail("RainyThunderstorm");
                case "snow": case "snowgentle": return DefDatabase<WeatherDef>.GetNamedSilentFail("SnowGentle");
                case "snowhard": case "blizzard": return DefDatabase<WeatherDef>.GetNamedSilentFail("SnowHard");
            }
            return DefDatabase<WeatherDef>.GetNamedSilentFail(key);
        }

        /// <summary>Rendered/environmental snapshot at a cell — the read side of a headless visual check.</summary>
        private static object DescribeEnvironment(IntVec3 c, Map map)
        {
            // GroundGlowAt(cell, ignoreCavePlants, ignoreSky): total light vs. artificial-only.
            // Their difference is what the sky (an open cell or a skylight) is admitting — the number
            // that tells you a skylight is working without anyone looking at the screen.
            float totalGlow = map.glowGrid.GroundGlowAt(c, false, false);
            float artificialGlow = map.glowGrid.GroundGlowAt(c, false, true);
            float skyContribution = Math.Max(0f, totalGlow - artificialGlow);
            var wm = map.weatherManager;
            return new
            {
                cell = new { x = c.x, z = c.z },
                roof = map.roofGrid.RoofAt(c)?.defName ?? "None",
                groundGlow = totalGlow,          // gameplay light reaching the cell (0..1)
                artificialGlow,                  // same but with the sky excluded
                skyContribution,                 // light the sky/skylight is admitting to this cell
                psychGlow = map.glowGrid.PsychGlowAt(c).ToString(),   // Dark / Lit / Overlit
                curSkyGlow = map.skyManager.CurSkyGlow,               // ambient outdoor brightness (0=night,1=day)
                celestialSunGlow = GenCelestial.CurCelestialSunGlow(map),
                isDaytime = GenCelestial.IsDaytime(GenCelestial.CurCelestialSunGlow(map)),
                hourOfDay = GenLocalDate.HourOfDay(map),
                weather = wm.curWeather?.defName ?? "None",
                weatherLabel = wm.curWeather?.label,
                rainRate = wm.RainRate,
                snowRate = wm.SnowRate
            };
        }

        private static void RegisterEnvControlTools()
        {
            // Tool: get_bridge_status — readiness probe. Deliberately has NO map guard: a successful
            // response is itself the signal that the bridge is polling, and mapLive tells the caller
            // whether the map is ready to drive. Launch tools poll this to block until load finishes
            // instead of blind-sleeping and racing load-time timeouts.
            RegisterTool(
                "get_bridge_status",
                "Readiness probe for the in-game bridge. Returns programState, whether a live map exists (mapLive), and basic world state. A response at all means the bridge is polling; mapLive:true means the map is ready to drive. Never requires a map — safe to call during/after load.",
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = new Dictionary<string, object>() },
                args =>
                {
                    try
                    {
                        bool playing = Current.ProgramState == ProgramState.Playing;
                        var map = playing ? Find.CurrentMap : null;

                        object mapSize = null;
                        int hour = -1, colonists = 0;
                        if (map != null)
                        {
                            mapSize = new { x = map.Size.x, z = map.Size.z };
                            hour = GenLocalDate.HourOfDay(map);
                            try { colonists = map.mapPawns.FreeColonistsCount; } catch { }
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            programState = Current.ProgramState.ToString(),
                            mapLive = map != null,
                            mapSize,
                            ticksGame = (playing && Find.TickManager != null) ? Find.TickManager.TicksGame : 0,
                            hourOfDay = hour,
                            colonistCount = colonists
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to read status: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "status", "ready", "readiness", "ping", "loaded", "map", "live", "state" }
            );

            // Tool: set_weather — force the weather a test needs (e.g. Rain to check a rain-hiding fix).
            RegisterTool(
                "set_weather",
                "Transition the current map to a weather condition so weather-dependent behavior can be verified. weather: friendly name (clear | rain | foggyrain | fog | thunderstorm | snow | snowhard) or an exact WeatherDef defName. Returns the resulting weather with its rain/snow rates.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["weather"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Friendly name or WeatherDef defName. Default 'clear'." }
                    }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        string key = ArgStr(d, "weather") ?? "clear";
                        var wd = ResolveWeather(key);
                        if (wd == null) return $"{{\"error\": \"No weather '{key}'. Use clear|rain|foggyrain|fog|thunderstorm|snow|snowhard or a WeatherDef defName.\"}}";

                        map.weatherManager.TransitionTo(wd);
                        // TransitionTo lerps in; force curWeather so RainRate/SnowRate read true immediately.
                        map.weatherManager.curWeather = wd;
                        map.weatherManager.curWeatherAge = 0;

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            weather = wd.defName,
                            label = wd.label,
                            rainRate = map.weatherManager.RainRate,
                            snowRate = map.weatherManager.SnowRate,
                            note = "Weather is not locked — the map's weather decider may transition away over time. Re-call before a check if needed."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to set weather: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "weather", "rain", "snow", "fog", "storm", "clear" }, isMutating: true
            );

            // Tool: set_time — jump the game clock to a target hour so night-only visuals (moonlight)
            // can be checked without waiting out the day cycle. Persistent and celestially correct
            // (unlike a one-frame sky-glow override): the sun glow and moonlight follow the new time.
            RegisterTool(
                "set_time",
                "Jump the in-game clock to a target hour of day (0-23 local time) on the current map, so time-of-day visuals (e.g. moonlight through a skylight at night) can be verified without waiting. Advances the whole game clock forward to the next occurrence of that hour; sky glow and celestial position follow. Returns the new hour and light readings.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["hour"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Target hour of day, 0-23 (0 = midnight, 12 = noon, 22 = night)." }
                    },
                    ["required"] = new List<string> { "hour" }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        int targetHour = ((ArgInt(d, "hour", 12) % 24) + 24) % 24;
                        int currentHour = GenLocalDate.HourOfDay(map);
                        int deltaHours = ((targetHour - currentHour) % 24 + 24) % 24; // forward-only jump

                        var tm = Find.TickManager;
                        tm.DebugSetTicksGame(tm.TicksGame + deltaHours * TicksPerHour);

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            requestedHour = targetHour,
                            hourOfDay = GenLocalDate.HourOfDay(map),
                            advancedHours = deltaHours,
                            curSkyGlow = map.skyManager.CurSkyGlow,
                            celestialSunGlow = GenCelestial.CurCelestialSunGlow(map),
                            isDaytime = GenCelestial.IsDaytime(GenCelestial.CurCelestialSunGlow(map)),
                            note = "curSkyGlow may lag one frame; celestialSunGlow is computed from the new time and is authoritative."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to set time: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "time", "hour", "night", "day", "noon", "midnight", "clock", "sky" }, isMutating: true
            );

            // Tool: move_camera — point the view at a cell so a follow-up capture_screen shows the
            // right area (spawns happen at grid coords the agent can't otherwise look at). View-only.
            RegisterTool(
                "move_camera",
                "Jump the map camera to center on cell (x, z) so a following capture_screen frames that area. Does not change game state — it only moves the view.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X to center on." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z to center on." }
                    },
                    ["required"] = new List<string> { "x", "z" }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        var cell = new IntVec3(ArgInt(d, "x", -1), 0, ArgInt(d, "z", -1));
                        if (!cell.InBounds(map)) return $"{{\"error\": \"Cell ({cell.x},{cell.z}) out of bounds.\"}}";

                        Find.CameraDriver?.JumpToCurrentMapLoc(cell);
                        return JsonConvert.SerializeObject(new { success = true, centeredOn = new { x = cell.x, z = cell.z } });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to move camera: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "camera", "view", "look", "pan", "center", "jump" }
            );

            // Tool: sample_environment — the headless visual check. Reports rendered light + weather at
            // a cell so an agent can confirm "the skylight admits sky light" / "it's dark at night" /
            // "it's raining" without a human eyeballing the lighting overlay. Read-only.
            RegisterTool(
                "sample_environment",
                "Read the rendered lighting + weather at cell (x, z): total ground glow, artificial-only glow, the sky's contribution (their difference — what an open cell or skylight is admitting), psych-glow band, current sky glow, celestial sun glow, day/night, hour, and weather with rain/snow rates. The headless way to verify a visual (skylight brightness, moonlight, rain) without a screenshot.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X to sample. Defaults to the map center." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z to sample. Defaults to the map center." }
                    }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        var cell = new IntVec3(
                            ArgInt(d, "x", map.Size.x / 2), 0,
                            ArgInt(d, "z", map.Size.z / 2));
                        if (!cell.InBounds(map)) return $"{{\"error\": \"Cell ({cell.x},{cell.z}) out of bounds.\"}}";

                        return JsonConvert.SerializeObject(new { success = true, environment = DescribeEnvironment(cell, map) });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to sample environment: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "sample", "glow", "light", "brightness", "weather", "rain", "moonlight", "verify", "visual" }
            );

            // Tool: fill_rect — spawn one def across a rectangle in a single call (perimeter or filled).
            // Kills the "walled room = 25 spawn_thing calls" grind.
            RegisterTool(
                "fill_rect",
                "Spawn a thing across every cell of rectangle (x,z)-(x2,z2) in one call. perimeterOnly:true places only the border (a wall ring); false fills the whole area. Skips cells already holding a same-def thing. Returns how many were placed.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["defName"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "ThingDef defName to place in each cell (e.g. 'Wall')." },
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect start X." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect start Z." },
                        ["x2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect end X (inclusive)." },
                        ["z2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect end Z (inclusive)." },
                        ["stuff"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Optional material defName for stuffable things (default chosen)." },
                        ["perimeterOnly"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "True = border cells only (wall ring); false = fill (default false)." }
                    },
                    ["required"] = new List<string> { "defName", "x", "z", "x2", "z2" }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        string defName = ArgStr(d, "defName");
                        if (string.IsNullOrEmpty(defName)) return "{\"error\": \"Missing 'defName'.\"}";
                        var def = DefDatabase<ThingDef>.GetNamedSilentFail(defName);
                        if (def == null) return $"{{\"error\": \"No ThingDef named '{defName}'.\"}}";

                        int x1 = ArgInt(d, "x", 0), z1 = ArgInt(d, "z", 0);
                        int x2 = ArgInt(d, "x2", x1), z2 = ArgInt(d, "z2", z1);
                        bool perimeter = d != null && d.TryGetValue("perimeterOnly", out var p) && p != null &&
                                         (p.ToString().ToLowerInvariant() == "true" || p.ToString() == "1");

                        ThingDef stuff = null;
                        if (def.MadeFromStuff)
                        {
                            string stuffName = ArgStr(d, "stuff");
                            stuff = stuffName != null ? DefDatabase<ThingDef>.GetNamedSilentFail(stuffName) : null;
                            if (stuff == null) stuff = GenStuff.DefaultStuffFor(def);
                        }

                        var rect = CellRect.FromLimits(Math.Min(x1, x2), Math.Min(z1, z2), Math.Max(x1, x2), Math.Max(z1, z2)).ClipInsideMap(map);
                        int placed = 0;
                        foreach (var c in rect)
                        {
                            if (perimeter && !(c.x == rect.minX || c.x == rect.maxX || c.z == rect.minZ || c.z == rect.maxZ)) continue;
                            if (c.GetThingList(map).Any(t => t.def == def)) continue; // idempotent-ish
                            var thing = ThingMaker.MakeThing(def, stuff);
                            GenSpawn.Spawn(thing, c, map, Rot4.North, WipeMode.Vanish);
                            placed++;
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            def = def.defName,
                            stuff = stuff?.defName,
                            placed,
                            perimeterOnly = perimeter,
                            rect = new { minX = rect.minX, minZ = rect.minZ, maxX = rect.maxX, maxZ = rect.maxZ }
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to fill rect: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "fill", "rect", "bulk", "wall", "area", "region", "spawn" }, isMutating: true
            );

            // Tool: build_room — the full test-room primitive in one call: wall ring + roof over the
            // interior. Replaces ~25 spawn_thing + a set_roof with a single call, so the prepared scene
            // is one line to rebuild after a relaunch.
            RegisterTool(
                "build_room",
                "Build an enclosed test room in one call: a wall ring around rectangle (x,z)-(x2,z2) plus a roof over the interior. wallDef defaults to 'Wall', wallStuff to 'Steel', roof to 'constructed' ('thin'/'thick'/'none' also accepted). Returns walls placed and interior cells roofed.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect start X." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect start Z." },
                        ["x2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect end X (inclusive)." },
                        ["z2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Rect end Z (inclusive)." },
                        ["wallDef"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Wall ThingDef defName. Default 'Wall'." },
                        ["wallStuff"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Wall material defName. Default 'Steel'." },
                        ["roof"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "'constructed' | 'thin' | 'thick' | 'none'. Default 'constructed'." }
                    },
                    ["required"] = new List<string> { "x", "z", "x2", "z2" }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;
                        var map = Find.CurrentMap;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        int x1 = ArgInt(d, "x", 0), z1 = ArgInt(d, "z", 0);
                        int x2 = ArgInt(d, "x2", x1), z2 = ArgInt(d, "z2", z1);

                        var wallDef = DefDatabase<ThingDef>.GetNamedSilentFail(ArgStr(d, "wallDef") ?? "Wall");
                        if (wallDef == null) return "{\"error\": \"No wall ThingDef (looked up 'Wall'). Pass wallDef.\"}";
                        ThingDef wallStuff = null;
                        if (wallDef.MadeFromStuff)
                        {
                            wallStuff = DefDatabase<ThingDef>.GetNamedSilentFail(ArgStr(d, "wallStuff") ?? "Steel")
                                        ?? GenStuff.DefaultStuffFor(wallDef);
                        }

                        string roofKey = (ArgStr(d, "roof") ?? "constructed").ToLowerInvariant();
                        RoofDef roof;
                        bool noRoof = roofKey == "none" || roofKey == "remove" || roofKey == "clear";
                        if (noRoof) roof = null;
                        else if (roofKey == "thin" || roofKey == "rock") roof = RoofDefOf.RoofRockThin;
                        else if (roofKey == "thick" || roofKey == "mountain") roof = RoofDefOf.RoofRockThick;
                        else roof = RoofDefOf.RoofConstructed;

                        var rect = CellRect.FromLimits(Math.Min(x1, x2), Math.Min(z1, z2), Math.Max(x1, x2), Math.Max(z1, z2)).ClipInsideMap(map);

                        int walls = 0, roofed = 0;
                        foreach (var c in rect)
                        {
                            bool border = c.x == rect.minX || c.x == rect.maxX || c.z == rect.minZ || c.z == rect.maxZ;
                            if (border)
                            {
                                if (!c.GetThingList(map).Any(t => t.def == wallDef))
                                {
                                    var wall = ThingMaker.MakeThing(wallDef, wallStuff);
                                    GenSpawn.Spawn(wall, c, map, Rot4.North, WipeMode.Vanish);
                                    walls++;
                                }
                            }
                            else if (!noRoof)
                            {
                                map.roofGrid.SetRoof(c, roof);
                                roofed++;
                            }
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            wallDef = wallDef.defName,
                            wallStuff = wallStuff?.defName,
                            wallsPlaced = walls,
                            roof = noRoof ? "None" : roof.defName,
                            interiorRoofed = roofed,
                            interior = new { minX = rect.minX + 1, minZ = rect.minZ + 1, maxX = rect.maxX - 1, maxZ = rect.maxZ - 1 },
                            hint = "Spawn a skylight/glower in the interior, then sample_environment there to verify light admitted through the roof."
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to build room: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "room", "build", "walls", "enclosed", "test", "scene" }, isMutating: true
            );
        }
    }
}
