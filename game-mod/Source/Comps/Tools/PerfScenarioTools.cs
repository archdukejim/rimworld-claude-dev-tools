using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Newtonsoft.Json;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using Verse;

namespace RimAgentic
{
    /// <summary>
    /// Layer 2 of the performance harness: build standardized, reproducible benchmark scenarios —
    /// {biome} x {early|late colony}. A scenario is a live map populated with a deterministic colony
    /// load (fixed pawn/animal/item counts per maturity, seeded), which is what dominates tick cost.
    ///
    /// newMap:true force-generates a fresh map of the requested biome (overriding the world tile's
    /// biome so jungle/tundra are available regardless of the loaded save's world). It always falls
    /// back to populating the current map if world generation isn't available, so the deterministic
    /// colony load — the part that actually matters for tick cost — never depends on the fragile
    /// map-generation path.
    /// </summary>
    public static class PerfScenario
    {
        // Per-maturity load. Tuned so "late" is a heavy but survivable tick load; "early" is a small colony.
        private struct Load { public int colonists, animals, itemStacks; }
        private static Load LoadFor(bool late)
        {
            return late
                ? new Load { colonists = 14, animals = 40, itemStacks = 60 }
                : new Load { colonists = 3, animals = 6, itemStacks = 12 };
        }

        private static readonly string[] WildAnimalDefs = { "Muffalo", "Rat", "Hare", "Squirrel", "Deer", "Boomrat" };

        public static object Build(string biomeName, string maturity, int seed, int mapSize, bool newMap)
        {
            bool late = (maturity ?? "").Trim().ToLowerInvariant().StartsWith("l");
            BiomeDef biome = string.IsNullOrEmpty(biomeName) ? null : BiomeDef.Named(biomeName);
            if (!string.IsNullOrEmpty(biomeName) && biome == null)
                return Err($"Unknown biome '{biomeName}'. Use a BiomeDef defName like TemperateForest, TropicalRainforest, Tundra, IceSheet.");

            string note = null;
            Map map = Find.CurrentMap;

            if (newMap)
            {
                if (Find.World == null)
                    return Err("No world loaded — start or load a game first (a map or the world must exist).");
                try
                {
                    map = GenerateBiomeMap(biome, Math.Max(75, mapSize), seed, ref note);
                }
                catch (Exception ex)
                {
                    if (Find.CurrentMap == null)
                        return Err($"Map generation failed and there is no current map to fall back to: {ex.Message}");
                    map = Find.CurrentMap;
                    note = $"map generation failed ({ex.Message}); populated the current map instead";
                }
            }

            if (map == null)
                return Err("No map available. Load a game, or pass newMap:true to generate one.");

            int addedColonists = 0, addedAnimals = 0, addedItems = 0;
            var load = LoadFor(late);
            Rand.PushState(seed);
            try
            {
                addedColonists = SpawnColonists(map, load.colonists);
                addedAnimals = SpawnAnimals(map, load.animals);
                addedItems = SpawnItemStacks(map, load.itemStacks);
            }
            finally { Rand.PopState(); }

            string biomeDefName = map.Biome != null ? map.Biome.defName : null;
            return new
            {
                ok = true,
                scenarioId = (biomeDefName ?? "unknown") + "_" + (late ? "late" : "early"),
                biome = biomeDefName,
                maturity = late ? "late" : "early",
                seed,
                added = new { colonists = addedColonists, animals = addedAnimals, itemStacks = addedItems },
                map = new
                {
                    cells = map.Size.x * map.Size.z,
                    colonists = map.mapPawns != null ? map.mapPawns.FreeColonistsCount : 0,
                    pawns = map.mapPawns != null ? map.mapPawns.AllPawnsSpawned.Count : 0,
                    things = map.listerThings != null ? map.listerThings.AllThings.Count : 0
                },
                note,
                next = "Place your mod's new objects on this map, then run perf_benchmark_start to measure."
            };
        }

        private static Map GenerateBiomeMap(BiomeDef biome, int mapSize, int seed, ref string note)
        {
            var player = Faction.OfPlayer;

            // Find a settleable tile — prefer one that already is the target biome.
            PlanetTile tile;
            bool forced = false;
            if (biome != null)
            {
                tile = TileFinder.RandomSettlementTileFor(player, false, t =>
                {
                    try { return Find.WorldGrid[t].PrimaryBiome == biome; } catch { return false; }
                });
                if (!tile.Valid)
                {
                    tile = TileFinder.RandomSettlementTileFor(player, false, null);
                    forced = ForceBiome(tile, biome);
                }
            }
            else
            {
                tile = TileFinder.RandomSettlementTileFor(player, false, null);
            }
            if (!tile.Valid) throw new Exception("could not find a settleable world tile");

            // A map needs a MapParent at the tile; make a player settlement if none exists.
            if (Find.WorldObjects.MapParentAt(tile) == null)
            {
                var settlement = (Settlement)WorldObjectMaker.MakeWorldObject(WorldObjectDefOf.Settlement);
                settlement.Tile = tile;
                settlement.SetFaction(player);
                settlement.Name = "PerfBench";
                Find.WorldObjects.Add(settlement);
            }

            Rand.PushState(seed);
            Map map;
            try
            {
                map = GetOrGenerateMapUtility.GetOrGenerateMap(tile, new IntVec3(mapSize, 1, mapSize), null);
            }
            finally { Rand.PopState(); }

            Current.Game.CurrentMap = map;
            if (biome != null && !forced && map.Biome != biome)
                note = $"world had no {biome.defName} tile and biome override didn't take; generated on {map.Biome?.defName} instead";
            return map;
        }

        /// <summary>Best-effort: override a world tile's biome field so map gen produces the target biome.</summary>
        private static bool ForceBiome(PlanetTile tile, BiomeDef biome)
        {
            try
            {
                object tobj = Find.WorldGrid[tile];
                var f = AccessTools.Field(tobj.GetType(), "biome") ?? AccessTools.Field(typeof(Tile), "biome");
                if (f != null && f.FieldType == typeof(BiomeDef)) { f.SetValue(tobj, biome); return true; }
            }
            catch { }
            return false;
        }

        private static IntVec3 NearCenter(Map map)
        {
            IntVec3 c;
            if (CellFinder.TryFindRandomCellNear(map.Center, map, 30, x => x.Standable(map) && !x.Fogged(map), out c))
                return c;
            return map.Center;
        }

        private static int SpawnColonists(Map map, int count)
        {
            int made = 0;
            for (int i = 0; i < count; i++)
            {
                try
                {
                    var p = PawnGenerator.GeneratePawn(PawnKindDefOf.Colonist, Faction.OfPlayer);
                    if (GenSpawn.Spawn(p, NearCenter(map), map) != null) made++;
                }
                catch { }
            }
            return made;
        }

        private static int SpawnAnimals(Map map, int count)
        {
            var kinds = WildAnimalDefs
                .Select(n => DefDatabase<PawnKindDef>.GetNamedSilentFail(n))
                .Where(k => k != null).ToList();
            if (kinds.Count == 0) return 0;
            int made = 0;
            for (int i = 0; i < count; i++)
            {
                try
                {
                    var kind = kinds[i % kinds.Count];
                    var a = PawnGenerator.GeneratePawn(kind, null);
                    if (GenSpawn.Spawn(a, NearCenter(map), map) != null) made++;
                }
                catch { }
            }
            return made;
        }

        private static int SpawnItemStacks(Map map, int stacks)
        {
            var defs = new[] { "Steel", "WoodLog", "MealSimple", "Cloth", "MedicineHerbal" }
                .Select(n => DefDatabase<ThingDef>.GetNamedSilentFail(n))
                .Where(d => d != null).ToList();
            if (defs.Count == 0) return 0;
            int made = 0;
            for (int i = 0; i < stacks; i++)
            {
                try
                {
                    var def = defs[i % defs.Count];
                    var thing = ThingMaker.MakeThing(def, GenStuff.DefaultStuffFor(def));
                    thing.stackCount = Mathf.Max(1, def.stackLimit);
                    if (GenPlace.TryPlaceThing(thing, NearCenter(map), map, ThingPlaceMode.Near)) made++;
                }
                catch { }
            }
            return made;
        }

        private static object Err(string msg) { return new { ok = false, error = msg }; }
    }

    public static partial class SynapseToolRegistry
    {
        private static void RegisterPerfScenarioTools()
        {
            RegisterTool(
                "perf_scenario_build",
                "Build a standardized, reproducible performance scenario: a live map populated with a deterministic " +
                "colony load (fixed colonist/animal/item counts by maturity, seeded). With newMap:true it force-" +
                "generates a fresh map of the requested biome (jungle/tundra/etc., available regardless of the loaded " +
                "save's world); otherwise it populates the CURRENT map. Use maturity 'early' or 'late'. After building, " +
                "place your mod's new objects on the map, then run perf_benchmark_start. To measure your mod's impact: " +
                "build the same scenario (same biome+maturity+seed) with your mod off for the baseline, and on (plus " +
                "your objects) for the test — the tick-time delta is the impact.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["biome"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "BiomeDef defName, e.g. TemperateForest, TropicalRainforest, Tundra, IceSheet. Only used with newMap:true." },
                        ["maturity"] = new Dictionary<string, object> { ["type"] = "string", ["description"] = "'early' (small colony) or 'late' (large colony)." },
                        ["newMap"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Generate a fresh map of 'biome' (default false = populate the current map)." },
                        ["seed"] = new Dictionary<string, object> { ["type"] = "number", ["description"] = "RNG seed for reproducible generation/population (default 1)." },
                        ["mapSize"] = new Dictionary<string, object> { ["type"] = "number", ["description"] = "Map edge size when newMap:true (default 250)." }
                    },
                    ["required"] = new List<object> { "maturity" }
                },
                args =>
                {
                    try
                    {
                        var a = JsonConvert.DeserializeObject<Dictionary<string, object>>(string.IsNullOrEmpty(args) ? "{}" : args) ?? new Dictionary<string, object>();
                        string biome = a.TryGetValue("biome", out var bv) ? bv?.ToString() : null;
                        string maturity = a.TryGetValue("maturity", out var mv) ? mv?.ToString() : "early";
                        bool newMap = a.TryGetValue("newMap", out var nv) && (nv is bool nb ? nb : nv?.ToString() == "true");
                        int seed = 1, mapSize = 250;
                        if (a.TryGetValue("seed", out var sv) && int.TryParse(sv?.ToString(), out int s)) seed = s;
                        if (a.TryGetValue("mapSize", out var mz) && int.TryParse(mz?.ToString(), out int z)) mapSize = z;
                        return JsonConvert.SerializeObject(PerfScenario.Build(biome, maturity, seed, mapSize, newMap));
                    }
                    catch (Exception ex) { return JsonConvert.SerializeObject(new { ok = false, error = ex.Message }); }
                },
                false,
                null,
                true // mutating: spawns pawns/items and can generate a map
            );
        }
    }
}
