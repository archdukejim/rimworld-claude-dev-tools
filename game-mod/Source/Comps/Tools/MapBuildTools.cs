using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using RimWorld;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Map-building tools so map-object behavior can be tested headlessly, without mouse/keyboard
    /// injection reaching the game.
    ///
    /// RimWorld's built-in "place" debug commands arm a cursor mode that then needs a map click —
    /// which the bridge can't deliver — and the read-only inspectors can't call a method like
    /// GenSpawn.Spawn. So there was no way to set up a scenario (e.g. a glower under a constructed
    /// roof vs. thick mountain vs. open sky) from a session. These tools construct that state at
    /// grid coordinates, read it back, and tear it down.
    ///
    /// All run on the Unity main thread (the IPC poller dispatches handlers through the
    /// GameComponent's main-thread queue), so touching Map/Thing state directly is safe.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        /// <summary>Guard: a live map is required. Returns an error JSON string when there isn't one, else null.</summary>
        private static string RequireMapError()
        {
            if (Current.ProgramState != ProgramState.Playing || Find.CurrentMap == null)
                return "{\"error\": \"No live map — RimWorld is at the main menu or still loading.\"}";
            return null;
        }

        private static int ArgInt(Dictionary<string, object> d, string key, int fallback)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null)
            {
                try { return Convert.ToInt32(v); } catch { }
            }
            return fallback;
        }

        private static string ArgStr(Dictionary<string, object> d, string key)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null)
            {
                var s = v.ToString().Trim();
                return s.Length == 0 ? null : s;
            }
            return null;
        }

        /// <summary>Compact snapshot of a cell: roof, and each thing's id/def/inspect string.</summary>
        private static object DescribeCell(IntVec3 c, Map map)
        {
            var roof = map.roofGrid.RoofAt(c);
            var things = c.GetThingList(map).Select(t => new
            {
                thingId = t.ThingID,
                def = t.def?.defName,
                label = t.Label,
                comps = (t is ThingWithComps twc) ? twc.AllComps.Select(cp => cp.GetType().Name).ToList() : new List<string>(),
                inspect = SafeInspect(t)
            }).ToList();
            return new { x = c.x, z = c.z, roof = roof?.defName ?? "None", things };
        }

        /// <summary>GetInspectString can throw mid-tick on a half-built thing; never let that sink a read.</summary>
        private static string SafeInspect(Thing t)
        {
            try { return t.GetInspectString(); } catch (Exception ex) { return $"<inspect threw: {ex.Message}>"; }
        }

        private static void RegisterMapBuildTools()
        {
            // Tool: spawn_thing — the core unblock. Materialize a thing at a cell via GenSpawn.Spawn.
            RegisterTool(
                "spawn_thing",
                "Spawn a thing at map cell (x, z) on the current map — the headless equivalent of Dev > Try place. Returns the spawned thing's id, position and inspect string. For stuffable buildings pass 'stuff' (a material defName) or a sensible default is chosen.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["defName"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "ThingDef defName to spawn (e.g. 'Skylight_Dome')." },
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X coordinate." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z coordinate." },
                        ["stuff"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Optional material defName for stuffable things (e.g. 'Steel'). Ignored for non-stuffable." },
                        ["rotation"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Optional rotation 0-3 (N/E/S/W). Default 0." }
                    },
                    ["required"] = new List<string> { "defName", "x", "z" }
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
                        if (def == null) return $"{{\"error\": \"No ThingDef named '{defName}'. Check the defName with search_defs.\"}}";

                        var cell = new IntVec3(ArgInt(d, "x", -1), 0, ArgInt(d, "z", -1));
                        if (!cell.InBounds(map)) return $"{{\"error\": \"Cell ({cell.x},{cell.z}) is out of bounds for the {map.Size.x}x{map.Size.z} map.\"}}";

                        ThingDef stuff = null;
                        if (def.MadeFromStuff)
                        {
                            string stuffName = ArgStr(d, "stuff");
                            stuff = stuffName != null ? DefDatabase<ThingDef>.GetNamedSilentFail(stuffName) : null;
                            if (stuff == null) stuff = GenStuff.DefaultStuffFor(def);
                        }

                        var thing = ThingMaker.MakeThing(def, stuff);
                        var rot = new Rot4(ArgInt(d, "rotation", 0));
                        var spawned = GenSpawn.Spawn(thing, cell, map, rot, WipeMode.Vanish);

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            thingId = spawned.ThingID,
                            def = def.defName,
                            stuff = stuff?.defName,
                            position = new { x = spawned.Position.x, z = spawned.Position.z },
                            roofAt = map.roofGrid.RoofAt(spawned.Position)?.defName ?? "None",
                            inspect = SafeInspect(spawned)
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to spawn: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "spawn", "place", "create", "thing", "build", "dome" }, isMutating: true
            );

            // Tool: set_roof — build the roof condition a test needs: constructed / thin / thick / none.
            RegisterTool(
                "set_roof",
                "Set or clear the roof over a cell, or a rectangle (x,z)-(x2,z2). roof: 'constructed', 'thin' (rock), 'thick' (mountain), or 'none'/'remove' to strip it. Lets a test stage the same object under different roofs.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X (rect start)." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z (rect start)." },
                        ["x2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Optional rect end X (inclusive). Defaults to x." },
                        ["z2"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Optional rect end Z (inclusive). Defaults to z." },
                        ["roof"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "'constructed' | 'thin' | 'thick' | 'none'/'remove'. Default 'constructed'." }
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
                        int x1 = ArgInt(d, "x", 0), z1 = ArgInt(d, "z", 0);
                        int x2 = ArgInt(d, "x2", x1), z2 = ArgInt(d, "z2", z1);

                        string roofKey = (ArgStr(d, "roof") ?? "constructed").ToLowerInvariant();
                        RoofDef roof;
                        bool remove = roofKey == "none" || roofKey == "remove" || roofKey == "clear";
                        if (remove) roof = null;
                        else if (roofKey == "thin" || roofKey == "rock" || roofKey == "thinrock") roof = RoofDefOf.RoofRockThin;
                        else if (roofKey == "thick" || roofKey == "mountain" || roofKey == "overheadmountain") roof = RoofDefOf.RoofRockThick;
                        else if (roofKey == "constructed") roof = RoofDefOf.RoofConstructed;
                        else return $"{{\"error\": \"Unknown roof '{roofKey}'. Use constructed | thin | thick | none.\"}}";

                        var rect = CellRect.FromLimits(Math.Min(x1, x2), Math.Min(z1, z2), Math.Max(x1, x2), Math.Max(z1, z2)).ClipInsideMap(map);
                        int changed = 0;
                        foreach (var c in rect)
                        {
                            map.roofGrid.SetRoof(c, roof);
                            changed++;
                        }

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            roof = remove ? "None" : roof.defName,
                            cellsChanged = changed,
                            rect = new { minX = rect.minX, minZ = rect.minZ, maxX = rect.maxX, maxZ = rect.maxZ }
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to set roof: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "roof", "mountain", "overhead", "ceiling", "sky" }, isMutating: true
            );

            // Tool: finish_research — unlock tech so buildables/behaviors gated on research are available.
            RegisterTool(
                "finish_research",
                "Complete a research project by defName, or all projects when defName is omitted. Use to unlock content a test depends on.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["defName"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "ResearchProjectDef defName to finish. Omit to finish every project." }
                    }
                },
                args =>
                {
                    try
                    {
                        var err = RequireMapError();
                        if (err != null) return err;

                        var d = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        string defName = ArgStr(d, "defName");
                        var mgr = Find.ResearchManager;

                        if (!string.IsNullOrEmpty(defName))
                        {
                            var proj = DefDatabase<ResearchProjectDef>.GetNamedSilentFail(defName);
                            if (proj == null) return $"{{\"error\": \"No ResearchProjectDef named '{defName}'.\"}}";
                            if (!proj.IsFinished) mgr.FinishProject(proj);
                            return JsonConvert.SerializeObject(new { success = true, finished = new[] { proj.defName } });
                        }

                        var done = new List<string>();
                        foreach (var proj in DefDatabase<ResearchProjectDef>.AllDefsListForReading)
                        {
                            if (!proj.IsFinished) { mgr.FinishProject(proj); done.Add(proj.defName); }
                        }
                        return JsonConvert.SerializeObject(new { success = true, finishedCount = done.Count });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to finish research: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "research", "unlock", "tech", "finish" }, isMutating: true
            );

            // Tool: inspect_thing_at — read a cell back: roof + each thing's inspect string and comps.
            // The read half of the loop: stage with spawn_thing/set_roof, then verify behavior here.
            RegisterTool(
                "inspect_thing_at",
                "Read the state of map cell (x, z): its roof and every thing on it, each with its live inspect string and comp list. Call it after spawn_thing / set_roof, or later to watch state change (e.g. a glower tracking day/night).",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X coordinate." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z coordinate." }
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

                        return JsonConvert.SerializeObject(new
                        {
                            success = true,
                            glowAt = map.glowGrid.GroundGlowAt(cell),
                            cell = DescribeCell(cell, map)
                        });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to inspect cell: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "inspect", "read", "cell", "glow", "state" }
            );

            // Tool: destroy_thing_at — tear down between iterations so a test can re-stage cleanly.
            RegisterTool(
                "destroy_thing_at",
                "Destroy things at cell (x, z). By default destroys buildings/items but leaves terrain and pawns; pass defName to destroy only matching things.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["x"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell X coordinate." },
                        ["z"] = new Dictionary<string, object> { ["type"] = "integer", ["description"] = "Cell Z coordinate." },
                        ["defName"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "Optional: only destroy things whose def matches this." }
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
                        string only = ArgStr(d, "defName");

                        var destroyed = new List<string>();
                        // Snapshot first — destroying mutates the cell's thing list.
                        foreach (var t in cell.GetThingList(map).ToList())
                        {
                            if (t is Pawn) continue;
                            if (only != null && t.def?.defName != only) continue;
                            if (t.def == null || t.def.category == ThingCategory.Mote) continue;
                            destroyed.Add($"{t.def.defName}:{t.ThingID}");
                            if (!t.Destroyed) t.Destroy(DestroyMode.Vanish);
                        }

                        return JsonConvert.SerializeObject(new { success = true, destroyedCount = destroyed.Count, destroyed });
                    }
                    catch (Exception ex)
                    {
                        return $"{{\"error\": \"Failed to destroy: {ex.Message}\"}}";
                    }
                },
                isDebug: false, keywords: new List<string> { "destroy", "delete", "remove", "cleanup" }, isMutating: true
            );
        }
    }
}
