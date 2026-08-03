using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using Verse;
using Newtonsoft.Json;

namespace RimToolkit
{
    /// <summary>
    /// Tool handler: get_map_environment
    /// Returns biome, weather, temperature, overhead mountain cells, geothermal vents,
    /// and the turrets, generators, and doors present on the map.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        private static void RegisterEnvironmentTools()
        {
            RegisterTool(
                "get_map_environment",
                "Get environmental details of the player's map, including biome, current temperature, weather, cave/overhead mountain roof cell count, and number of geothermal steam vents.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["compact"] = new Dictionary<string, object>
                        {
                            ["type"] = "boolean",
                            ["description"] = "If true, returns extremely compact details to save token costs by omitting full turrets, doors, and generators details lists (returns counts instead)."
                        }
                    }
                },
                args =>
                {
                    bool compact = false;
                    try
                    {
                        var dict = JsonConvert.DeserializeObject<Dictionary<string, object>>(args);
                        if (dict != null && dict.TryGetValue("compact", out var val) && val is bool b)
                        {
                            compact = b;
                        }
                    }
                    catch {}

                    if (Find.CurrentMap == null) return "{\"error\": \"No active map loaded.\"}";
                    var map = Find.CurrentMap;

                    string biome = map.Biome?.LabelCap ?? "Unknown";
                    float temp = map.mapTemperature?.OutdoorTemp ?? 20f;
                    string weather = map.weatherManager?.curWeather?.LabelCap ?? "Clear";

                    int mountainCells = 0;
                    if (map.roofGrid != null)
                    {
                        foreach (var cell in map.AllCells)
                        {
                            if (map.roofGrid.RoofAt(cell) == RoofDefOf.RoofRockThick) mountainCells++;
                        }
                    }

                    int ventsCount = 0;
                    if (map.listerThings != null)
                    {
                        var ventDef = ThingDef.Named("SteamGeyser");
                        if (ventDef != null)
                        {
                            ventsCount = map.listerThings.ThingsOfDef(ventDef).Count;
                        }
                    }

                    var turretsList = new List<object>();
                    var generatorsList = new List<object>();
                    var doorsList = new List<object>();

                    if (map.listerThings != null)
                    {
                        foreach (var thing in map.listerThings.AllThings)
                        {
                            if (thing is Building_Turret turret)
                            {
                                turretsList.Add(new
                                {
                                    id = turret.GetUniqueLoadID(),
                                    defName = turret.def?.defName ?? "Turret",
                                    position = $"({turret.Position.x}, {turret.Position.z})"
                                });
                            }
                            else if (thing is Building building && building.GetComp<CompPowerPlant>() != null)
                            {
                                generatorsList.Add(new
                                {
                                    id = building.GetUniqueLoadID(),
                                    defName = building.def?.defName ?? "Generator",
                                    position = $"({building.Position.x}, {building.Position.z})"
                                });
                            }
                            else if (thing is Building_Door door)
                            {
                                doorsList.Add(new
                                {
                                    id = door.GetUniqueLoadID(),
                                    defName = door.def?.defName ?? "Door",
                                    position = $"({door.Position.x}, {door.Position.z})"
                                });
                            }
                        }
                    }

                    if (compact)
                    {
                        return JsonConvert.SerializeObject(new
                        {
                            biome = biome,
                            temp = temp,
                            weather = weather,
                            mountainCells = mountainCells,
                            vents = ventsCount,
                            turretsCount = turretsList.Count,
                            generatorsCount = generatorsList.Count,
                            doorsCount = doorsList.Count
                        });
                    }

                    return JsonConvert.SerializeObject(new
                    {
                        biome = biome,
                        currentTemperatureCelsius = temp,
                        currentWeather = weather,
                        overheadMountainRoofCells = mountainCells,
                        geothermalSteamVentsCount = ventsCount,
                        turrets = turretsList,
                        generators = generatorsList,
                        doors = doorsList
                    });
                }
            );
        }
    }
}
