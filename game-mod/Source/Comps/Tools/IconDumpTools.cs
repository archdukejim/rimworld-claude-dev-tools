using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RimWorld;
using UnityEngine;
using Verse;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RimAgentic
{
    /// <summary>
    /// Tool handler: dump_item_icons
    /// RimWorld ships Core/DLC art inside Unity .assets bundles, so vanilla item icons cannot be read
    /// as loose files from disk. This exports them the reliable way — from the *running* game, where
    /// each Def.uiIcon is a live Texture2D. It blits every icon to a readable RenderTexture, ReadPixels
    /// + EncodeToPNG, and writes &lt;defName&gt;.png into %LOCALAPPDATA%\RimAgentic\icons. That folder is the
    /// icon library the Workshop infographic tool (render_workshop_infographic) resolves against, so
    /// after one dump a stat-grid row like { k:"10 Mining skill", icon:"Steel" } finds the real icon.
    ///
    /// Runs on the main thread (harness handlers do), so the Unity texture APIs used here are legal.
    /// Defaults to OFFICIAL (Core + DLC) content only — that is exactly the gap the file resolver can't
    /// reach; mod textures are already loose PNGs it can find on its own.
    /// </summary>
    public static partial class SynapseToolRegistry
    {
        private static void RegisterIconDumpTools()
        {
            RegisterTool(
                "dump_item_icons",
                "Export RimWorld item icons (Def.uiIcon) to loose PNGs in %LOCALAPPDATA%\\RimAgentic\\icons " +
                "so the Workshop infographic tool can resolve vanilla icons by defName (e.g. icon:\"Steel\"). " +
                "Blits each uiIcon to a readable RenderTexture and EncodeToPNG. Defaults to OFFICIAL Core/DLC " +
                "content only, and to items/resources/weapons/apparel. Args: includeMods(bool), everything(bool " +
                "= every ThingDef with an icon, not just items), defNames(string[] to dump exactly those), " +
                "overwrite(bool, default true). Returns { ok, written, skipped, failed, dir, samples }. A full " +
                "dump can take several seconds; if the caller's 10s wait elapses the files are still written — " +
                "verify by listing the folder.",
                new Dictionary<string, object>
                {
                    ["type"] = "object",
                    ["properties"] = new Dictionary<string, object>
                    {
                        ["includeMods"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Include non-official (mod) defs too. Default false (official Core/DLC only)." },
                        ["everything"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Dump every ThingDef with an icon (buildings, plants, etc.), not just items/weapons/apparel. Default false." },
                        ["defNames"] = new Dictionary<string, object> { ["type"] = "array", ["items"] = new Dictionary<string, object> { ["type"] = "string" }, ["description"] = "If set, dump exactly these defNames and ignore the category/official filters." },
                        ["overwrite"] = new Dictionary<string, object> { ["type"] = "boolean", ["description"] = "Overwrite existing files. Default true." }
                    }
                },
                args =>
                {
                    try
                    {
                        Dictionary<string, object> opts = null;
                        if (!string.IsNullOrEmpty(args))
                        {
                            try { opts = JsonConvert.DeserializeObject<Dictionary<string, object>>(args); } catch { }
                        }
                        bool includeMods = IconArgBool(opts, "includeMods", false);
                        bool everything = IconArgBool(opts, "everything", false);
                        bool overwrite = IconArgBool(opts, "overwrite", true);

                        HashSet<string> only = null;
                        if (opts != null && opts.TryGetValue("defNames", out var dn) && dn is JArray arr)
                        {
                            var names = arr.Select(x => x?.ToString()).Where(s => !string.IsNullOrEmpty(s));
                            only = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
                        }

                        var dir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "RimAgentic", "icons");
                        Directory.CreateDirectory(dir);

                        int written = 0, skipped = 0, failed = 0;
                        var samples = new List<string>();

                        foreach (var def in DefDatabase<ThingDef>.AllDefs)
                        {
                            if (only != null)
                            {
                                if (!only.Contains(def.defName)) continue;
                            }
                            else
                            {
                                bool official = def.modContentPack != null && def.modContentPack.IsOfficialMod;
                                if (!includeMods && !official) continue;
                                if (!everything)
                                {
                                    bool isItem = def.category == ThingCategory.Item;
                                    bool isGear = def.IsWeapon || def.IsApparel;
                                    if (!isItem && !isGear) continue;
                                }
                            }

                            Texture2D tex = null;
                            try { tex = def.uiIcon; } catch { }
                            if (tex == null) { skipped++; continue; }

                            var outPath = Path.Combine(dir, IconSafeName(def.defName) + ".png");
                            if (!overwrite && File.Exists(outPath)) { skipped++; continue; }

                            try
                            {
                                byte[] png = EncodeIconPng(tex);
                                if (png == null || png.Length == 0) { failed++; continue; }
                                File.WriteAllBytes(outPath, png);
                                written++;
                                if (samples.Count < 12) samples.Add(def.defName);
                            }
                            catch { failed++; }
                        }

                        return JsonConvert.SerializeObject(new { ok = true, written, skipped, failed, dir, samples });
                    }
                    catch (Exception e)
                    {
                        return JsonConvert.SerializeObject(new { ok = false, error = e.Message });
                    }
                }
            );
        }

        /// <summary>Blit a (possibly non-readable) texture to a RenderTexture, read it back, encode PNG (alpha preserved).</summary>
        private static byte[] EncodeIconPng(Texture tex)
        {
            int w = tex.width, h = tex.height;
            if (w <= 0 || h <= 0 || w > 2048 || h > 2048) return null;

            var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var prevActive = RenderTexture.active;
            Texture2D readable = null;
            try
            {
                Graphics.Blit(tex, rt);            // straight copy, alpha included; sets active = rt
                readable = new Texture2D(w, h, TextureFormat.RGBA32, false);
                readable.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                readable.Apply(false);
                return readable.EncodeToPNG();
            }
            finally
            {
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (readable != null) UnityEngine.Object.Destroy(readable);
            }
        }

        private static string IconSafeName(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name;
        }

        private static bool IconArgBool(Dictionary<string, object> opts, string key, bool dflt)
        {
            if (opts != null && opts.TryGetValue(key, out var v) && v != null)
            {
                if (v is bool b) return b;
                if (bool.TryParse(v.ToString(), out var pb)) return pb;
            }
            return dflt;
        }
    }
}
